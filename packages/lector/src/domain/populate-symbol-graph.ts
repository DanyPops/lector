import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";
import type { OutgoingCall } from "./call-hierarchy.ts";
import type { DocumentSymbolEntry } from "./document-symbol.ts";
import type { IntelligenceProvenance } from "./intelligence-provenance.ts";
import { deriveSymbolNodeId } from "./symbol-node-id.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);
const MAX_RECORDED_FAILURES = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 500;

export interface SymbolGraphPopulationFailure {
	readonly path: string;
	readonly operation: "document-symbols" | "outgoing-calls";
	readonly code: string;
	readonly message: string;
	readonly provenance: IntelligenceProvenance;
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

/**
 * Walks documentSymbols for each file, then outgoingCalls for every callable
 * declaration found, to fill a SymbolGraphPort with real "contains" (free,
 * from the hierarchy already returned) and "calls" (one LSP round trip per
 * callable symbol) edges. maxSymbolsPerFile bounds a single large file's
 * declarations rather than processing an unbounded number from it.
 */
export async function populateSymbolGraph(
	index: CodeIntelligencePort,
	graph: SymbolGraphPort,
	files: readonly string[],
	maxSymbolsPerFile: number,
): Promise<PopulateSymbolGraphResult> {
	let filesProcessed = 0;
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
		if (failures.length < MAX_RECORDED_FAILURES) failures.push(boundedFailure(index, file, operation, error));
	}

	async function ensureNode(node: SymbolNode): Promise<void> {
		if (addedNodeIds.has(node.id)) return;
		addedNodeIds.add(node.id);
		await graph.addNode(node);
		nodesAdded++;
	}

	for (const file of files) {
		// Always released, success or failure (finally, not just the happy path): a bulk crawl
		// over many files doesn't need any of them to stay open once processed -- unlike a live
		// caller genuinely juggling several files at once, this is a one-shot read per file, and
		// leaving every one open is what silently exhausts LspSymbolIndex's open-file bound partway
		// through the very first population run on a real-sized repo.
		try {
			let topLevel: DocumentSymbolEntry[];
			try {
				topLevel = await index.documentSymbols(file);
			} catch (error) {
				recordFailure(file, "document-symbols", error);
				continue;
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
						callees = await index.outgoingCalls(location);
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
		}
	}

	return {
		completeness: failureCount === 0 ? "complete" : "partial",
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
