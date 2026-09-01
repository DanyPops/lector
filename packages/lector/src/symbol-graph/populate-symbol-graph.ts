import type { Logger } from "@danypops/vehicle-server/logging";
import type { DocumentSymbolEntry } from "../code-intelligence/document-symbol.ts";
import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { OutgoingCall } from "./call-hierarchy.ts";
import type { SymbolGraphPort, SymbolNode } from "./port.ts";
import { deriveSymbolNodeId } from "./symbol-node-id.ts";

const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);
const MAX_RECORDED_FAILURES = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 500;

/**
 * Known transient "this file hasn't been attached to a project yet" error messages --
 * observed live from typescript-language-server/tsserver and gopls specifically under
 * population's own reduced settle time and concurrency: a fast documentSymbols or
 * outgoingCalls request can race the server's own asynchronous project/package-file-set
 * attachment, especially for a large package where project discovery itself takes
 * longer. Never a permanent property of the file -- a different file in the same
 * generation succeeds, and the same file succeeds outright on a later generation --
 * so exactly one bounded retry is safe here in a way it would not be for a genuine
 * application error. gopls' own "no package metadata" phrasing is deliberately
 * matched loosely (no anchors) since it's reported inline with the offending path.
 */
const TRANSIENT_PROJECT_ATTACHMENT_PATTERNS: readonly RegExp[] = [/^No Project\.?$/i, /Could not find source file/i, /no package metadata/i];

function isTransientProjectAttachmentError(error: unknown): boolean {
	return error instanceof Error && TRANSIENT_PROJECT_ATTACHMENT_PATTERNS.some((pattern) => pattern.test(error.message));
}

/**
 * Retries `operation` exactly once when it fails with a known transient
 * project-attachment error, never for any other failure -- a real application
 * error (a malformed file, a genuine backend bug) must still surface on the
 * first attempt, not be silently masked behind a second try.
 */
async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isTransientProjectAttachmentError(error)) throw error;
		return await operation();
	}
}

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Overrides LspSymbolIndex's normal post-open settle wait for this crawl's own
 * documentSymbols/outgoingCalls calls specifically -- validated empirically, not
 * guessed: real fixtures (a 25-file synthetic cross-file call chain and a 53-file
 * slice of Lector's own production source, both exercising genuine cross-file
 * outgoingCalls resolution) produced byte-identical results at zero settle versus
 * the descriptor's normal default, across repeated runs, a 50-60x wall-clock
 * speedup. This is specifically NOT validated for goToDefinition/hover -- see
 * CodeIntelligencePort.documentSymbols's own doc comment for why those stay on
 * the conservative default and must never adopt this constant.
 */
const POPULATION_SETTLE_MS = 0;

export interface SymbolGraphPopulationFailure {
	readonly path: string;
	readonly operation: "document-symbols" | "outgoing-calls";
	readonly code: string;
	readonly message: string;
	readonly provenance: IntelligenceProvenance;
}

/** A live snapshot of an in-progress population, reported after each file completes -- filesTotal is known upfront (the caller already computed which files to walk before calling), so a caller can render a real fraction, not just an opaque "running" state. */
export interface PopulationProgress {
	/** Files whose complete document-symbol/call pipeline has settled, including failures. */
	readonly filesProcessed: number;
	readonly filesTotal: number;
	readonly filesSucceeded: number;
	readonly filesFailed: number;
	readonly symbolsProcessed: number;
	readonly nodesAdded: number;
	readonly edgesAdded: number;
	/** Filled by the service-level delta population wrapper. */
	readonly filesReused?: number;
	/** Filled by the service-level retry wrapper. */
	readonly staleRetries?: number;
}

export interface PopulateSymbolGraphResult {
	readonly completeness: "complete" | "partial";
	readonly filesAttempted: number;
	readonly filesProcessed: number;
	readonly filesFailed: number;
	readonly symbolsProcessed: number;
	/** addNode calls made, not necessarily new nodes -- a symbol reached from multiple edges is upserted once per encounter within a run, deduped in-memory. */
	readonly nodesAdded: number;
	readonly edgesAdded: number;
	readonly failureCount: number;
	readonly failures: readonly SymbolGraphPopulationFailure[];
	readonly failuresTruncated: boolean;
	/** Files reused from the previous generation without another LSP walk. */
	readonly filesReused?: number;
	/** Files selected as new, changed, or dependent on changed declarations. */
	readonly filesReprocessed?: number;
	/** Source-selection coverage for this bounded generation. */
	readonly sourceCoverage?: {
		readonly scannedEntries: number;
		readonly truncated: boolean;
		readonly scopes: readonly { readonly scope: string; readonly files: number }[];
		readonly scopeOmittedCount: number;
		readonly languages: readonly { readonly extension: string; readonly files: number }[];
		readonly languageOmittedCount: number;
	};
	/** Source-staleness retries consumed before this generation completed. */
	readonly staleRetries?: number;
	/** Exact bounded source-manifest identity recorded for a completed service generation. */
	readonly sourceGeneration?: string;
}

const UNKNOWN_PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "unavailable",
	languageId: "unknown",
	authority: "language-server",
	freshness: "live-process",
	limitations: ["source provenance was unavailable"],
};

function boundedFailure(
	index: CodeIntelligencePort,
	path: string,
	operation: SymbolGraphPopulationFailure["operation"],
	error: unknown,
): SymbolGraphPopulationFailure {
	const errorName = error instanceof Error ? error.name : undefined;
	return {
		path,
		operation,
		code: errorName && errorName !== "Error" ? errorName : "CodeIntelligenceFileError",
		message: (error instanceof Error ? error.message : String(error)).slice(0, MAX_FAILURE_MESSAGE_LENGTH),
		provenance: index.provenanceForPath?.(path) ?? index.provenance ?? UNKNOWN_PROVENANCE,
	};
}

function toLocation(entry: DocumentSymbolEntry): WorkspaceLocation {
	return { path: entry.selectionRange.path, line: entry.selectionRange.start.line, character: entry.selectionRange.start.character };
}

interface FlattenedEntry {
	readonly entry: DocumentSymbolEntry;
	readonly parentLocation: WorkspaceLocation | undefined;
}

/** Depth-first flatten of a documentSymbols hierarchy, keeping each entry's parent location for "contains" edges. */
function flattenDocumentSymbols(entries: readonly DocumentSymbolEntry[], parentLocation?: WorkspaceLocation): FlattenedEntry[] {
	const flattened: FlattenedEntry[] = [];
	for (const entry of entries) {
		flattened.push({ entry, parentLocation });
		if (entry.children) flattened.push(...flattenDocumentSymbols(entry.children, toLocation(entry)));
	}
	return flattened;
}

/** Default: strictly sequential, matching the crawl's original behavior exactly. Production passes a real value (service.ts's POPULATION_CONCURRENCY). */
const DEFAULT_POPULATION_CONCURRENCY = 1;

/**
 * Walks documentSymbols for each file, then outgoingCalls for every callable
 * declaration found, to fill a SymbolGraphPort with real "contains" (free,
 * from the hierarchy already returned) and "calls" (one LSP round trip per
 * callable symbol) edges. maxSymbolsPerFile bounds a single large file's
 * declarations rather than processing an unbounded number from it.
 *
 * `concurrency` dispatches up to that many files at once -- files are independent, and cost
 * is round-trip latency, not CPU (see populate-symbol-graph-concurrency.perf.test.ts). Caller
 * must keep it within the backend's own open-file bound (e.g. LspSymbolIndex.maxOpenFiles).
 */
export async function populateSymbolGraph(
	index: CodeIntelligencePort,
	graph: SymbolGraphPort,
	files: readonly string[],
	maxSymbolsPerFile: number,
	/** Warn per failure as it happens (a long-running background job has no other way to surface one before the crawl finishes), warn/info summary on completion. Defaults to a no-op. */
	logger: Logger = NOOP_LOGGER,
	concurrency: number = DEFAULT_POPULATION_CONCURRENCY,
	/** Fired once per file, after that file's own documentSymbols step completes -- not per-symbol, which would be far chattier for no real benefit to a caller only rendering a coarse progress fraction. Optional: a caller with nothing to do with progress (most direct/test callers) pays nothing. */
	onProgress?: (progress: PopulationProgress) => void,
): Promise<PopulateSymbolGraphResult> {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer");
	let filesProcessed = 0;
	let completedFiles = 0;
	let symbolsProcessed = 0;
	let nodesAdded = 0;
	let edgesAdded = 0;
	let failureCount = 0;
	const addedNodeIds = new Set<string>();
	const failedFiles = new Set<string>();
	const failures: SymbolGraphPopulationFailure[] = [];

	function recordFailure(file: string, operation: SymbolGraphPopulationFailure["operation"], error: unknown): void {
		failureCount++;
		failedFiles.add(file);
		const failure = boundedFailure(index, file, operation, error);
		if (failures.length < MAX_RECORDED_FAILURES) failures.push(failure);
		logger.warn("symbol graph population: file failed", {
			module: "populate-symbol-graph",
			path: failure.path,
			operation: failure.operation,
			code: failure.code,
			message: failure.message,
			languageId: failure.provenance.languageId,
		});
	}

	async function ensureNode(node: SymbolNode): Promise<void> {
		if (addedNodeIds.has(node.id)) return;
		addedNodeIds.add(node.id);
		await graph.addNode(node);
		nodesAdded++;
	}

	// Counters above are mutated from concurrent file pipelines, but every mutation is a
	// synchronous check-then-write with no `await` between -- safe under JS's single-threaded
	// interleaving, no lock needed.
	async function processOneFile(file: string): Promise<void> {
		try {
			let topLevel: DocumentSymbolEntry[];
			try {
				topLevel = await withTransientRetry(() => index.documentSymbols(file, { settleMs: POPULATION_SETTLE_MS }));
			} catch (error) {
				recordFailure(file, "document-symbols", error);
				return;
			}
			const flattened = flattenDocumentSymbols(topLevel).slice(0, maxSymbolsPerFile);
			filesProcessed++;

			for (const { entry, parentLocation } of flattened) {
				symbolsProcessed++;
				const location = toLocation(entry);
				const node: SymbolNode = { id: deriveSymbolNodeId(location), name: entry.name, kind: entry.kind, location };
				await ensureNode(node);

				if (parentLocation) {
					await graph.addEdge(deriveSymbolNodeId(parentLocation), node.id, "contains");
					edgesAdded++;
				}

				if (CALLABLE_KINDS.has(entry.kind)) {
					let callees: OutgoingCall[];
					try {
						callees = await withTransientRetry(() => index.outgoingCalls(location, { settleMs: POPULATION_SETTLE_MS }));
					} catch (error) {
						recordFailure(file, "outgoing-calls", error);
						continue;
					}
					for (const call of callees) {
						const calleeNode: SymbolNode = { id: deriveSymbolNodeId(call.to.location), name: call.to.name, kind: call.to.kind, location: call.to.location };
						await ensureNode(calleeNode);
						await graph.addEdge(node.id, calleeNode.id, "calls");
						edgesAdded++;
					}
				}
			}
		} finally {
			await index.releaseFile?.(file);
			completedFiles++;
			onProgress?.({
				filesProcessed: completedFiles,
				filesTotal: files.length,
				filesSucceeded: filesProcessed,
				filesFailed: failedFiles.size,
				symbolsProcessed,
				nodesAdded,
				edgesAdded,
			});
		}
	}

	// Bounded batches, not one unbounded Promise.all: at most `concurrency` files open at once.
	for (let start = 0; start < files.length; start += concurrency) {
		const batch = files.slice(start, start + concurrency);
		await Promise.all(batch.map((file) => processOneFile(file)));
	}

	const completeness = failureCount === 0 ? "complete" : "partial";
	const summaryFields = {
		module: "populate-symbol-graph",
		filesAttempted: files.length,
		filesProcessed,
		filesFailed: failedFiles.size,
		symbolsProcessed,
		nodesAdded,
		edgesAdded,
		failureCount,
	};
	if (completeness === "complete") logger.info("symbol graph population complete", summaryFields);
	else logger.warn("symbol graph population completed with failures", summaryFields);

	return {
		completeness,
		filesAttempted: files.length,
		filesProcessed,
		filesFailed: failedFiles.size,
		symbolsProcessed,
		nodesAdded,
		edgesAdded,
		failureCount,
		failures,
		failuresTruncated: failureCount > failures.length,
	};
}
