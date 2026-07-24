import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalFilesystemWorkspace } from "./adapters/local-filesystem-workspace.ts";
import { TypescriptSymbolIndex } from "./adapters/lsp/typescript-symbol-index.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./domain/call-hierarchy.ts";
import type { Diagnostic } from "./domain/diagnostic.ts";
import { diagnostics as diagnosticsQuery } from "./domain/diagnostics.ts";
import type { DocumentSymbolEntry } from "./domain/document-symbol.ts";
import { documentSymbols as documentSymbolsQuery } from "./domain/document-symbols.ts";
import { type EditOutcome, type ExpectedHashEdit, exactEdit, StaleExpectedHash } from "./domain/exact-edit.ts";
import { findReferences as findReferencesQuery } from "./domain/find-references.ts";
import { findWorkspaceSymbols } from "./domain/find-workspace-symbols.ts";
import { goToDefinition as goToDefinitionQuery } from "./domain/go-to-definition.ts";
import type { Hover } from "./domain/hover.ts";
import { hoverAt } from "./domain/hover-at.ts";
import { incomingCalls as incomingCallsQuery } from "./domain/incoming-calls.ts";
import { outgoingCalls as outgoingCallsQuery } from "./domain/outgoing-calls.ts";
import { prepareCallHierarchy as prepareCallHierarchyQuery } from "./domain/prepare-call-hierarchy.ts";
import { type RawRead, rawRead, WorkspaceEntryNotFound } from "./domain/raw-read.ts";
import type { WorkspaceLocation, WorkspaceSymbol } from "./domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "./ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "./ports/symbol-index-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";

/**
 * Identifies which registered workspace an operation targets. There is no
 * default/implicit workspace: an operation must always name one explicitly.
 * (Locus LCS-BUG-97/LCS-BUG-88 class -- an operation given no explicit
 * target must never fall back to "whatever was registered/used last".)
 */
export type WorkspaceId = string;

/** Raised when an operation names a workspaceId nothing was registered under. */
export class UnknownWorkspace extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`no workspace registered under id "${workspaceId}"`);
		this.name = "UnknownWorkspace";
	}
}

/** Raised when workspace.registerPath is given a path that isn't a real, accessible directory. */
export class InvalidWorkspaceRoot extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(`cannot register "${path}" as a workspace root: ${reason}`);
		this.name = "InvalidWorkspaceRoot";
	}
}

/** Raised when a symbol query targets a workspace with no known root path (not registered via workspace.registerPath). */
export class SymbolQueryUnavailable extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" has no known root path; symbol queries require a workspace registered via workspace.registerPath`);
		this.name = "SymbolQueryUnavailable";
	}
}

/**
 * Raised when a Tier A code-intelligence operation (goToDefinition, findReferences,
 * hover, documentSymbols) targets a workspace whose warm index is not backed by a
 * real language server -- e.g. a test override using the tree-sitter backend, which
 * has no type system and cannot honestly resolve cross-file references or types.
 * An honest failure, not a silent empty result or a crash.
 */
export class CodeIntelligenceUnavailable extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(
			`workspace "${workspaceId}"'s symbol index does not support code-intelligence queries (definition/references/hover/documentSymbols/diagnostics/callHierarchy) -- only findSymbols`,
		);
		this.name = "CodeIntelligenceUnavailable";
	}
}

export type OperationName =
	| "workspace.rawRead"
	| "workspace.exactEdit"
	| "workspace.registerPath"
	| "workspace.findSymbols"
	| "workspace.goToDefinition"
	| "workspace.findReferences"
	| "workspace.hover"
	| "workspace.documentSymbols"
	| "workspace.diagnostics"
	| "workspace.prepareCallHierarchy"
	| "workspace.incomingCalls"
	| "workspace.outgoingCalls";

export const OPERATION_NAMES: readonly OperationName[] = [
	"workspace.rawRead",
	"workspace.exactEdit",
	"workspace.registerPath",
	"workspace.findSymbols",
	"workspace.goToDefinition",
	"workspace.findReferences",
	"workspace.hover",
	"workspace.documentSymbols",
	"workspace.diagnostics",
	"workspace.prepareCallHierarchy",
	"workspace.incomingCalls",
	"workspace.outgoingCalls",
];

/** A single position within a file already registered under `workspaceId`, 1-indexed. */
interface WorkspacePosition {
	workspaceId: WorkspaceId;
	path: string;
	line: number;
	character: number;
}

export interface OperationInputs {
	"workspace.rawRead": { workspaceId: WorkspaceId; path: string };
	"workspace.exactEdit": { workspaceId: WorkspaceId } & ExpectedHashEdit;
	"workspace.registerPath": { path: string };
	"workspace.findSymbols": { workspaceId: WorkspaceId; query: string; seedFile?: string };
	"workspace.goToDefinition": WorkspacePosition;
	"workspace.findReferences": WorkspacePosition & { includeDeclaration: boolean };
	"workspace.hover": WorkspacePosition;
	"workspace.documentSymbols": { workspaceId: WorkspaceId; path: string };
	"workspace.diagnostics": { workspaceId: WorkspaceId; path: string };
	"workspace.prepareCallHierarchy": WorkspacePosition;
	"workspace.incomingCalls": WorkspacePosition;
	"workspace.outgoingCalls": WorkspacePosition;
}

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
	"workspace.registerPath": { workspaceId: WorkspaceId; created: boolean };
	"workspace.findSymbols": { symbols: readonly WorkspaceSymbol[] };
	"workspace.goToDefinition": { locations: readonly WorkspaceLocation[] };
	"workspace.findReferences": { locations: readonly WorkspaceLocation[] };
	"workspace.hover": { hover: Hover | undefined };
	"workspace.documentSymbols": { symbols: readonly DocumentSymbolEntry[] };
	"workspace.diagnostics": { diagnostics: readonly Diagnostic[] };
	"workspace.prepareCallHierarchy": { items: readonly CallHierarchyEntry[] };
	"workspace.incomingCalls": { calls: readonly IncomingCall[] };
	"workspace.outgoingCalls": { calls: readonly OutgoingCall[] };
}

/**
 * Deterministically derive a workspaceId from a resolved absolute path, so the same
 * directory always yields the same id -- across repeat calls AND across a daemon
 * restart, since nothing about this derivation depends on runtime/in-memory state.
 * A shorter digest than ContentHash's is deliberate: this identifies a workspace root
 * for addressing/logging, not a content value needing full collision resistance.
 */
function deriveWorkspaceId(absolutePath: string): WorkspaceId {
	return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

export interface LectorService {
	readonly operations: readonly OperationName[];
	dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	/** Stops every warm symbol-index subprocess this service spawned. Idempotent. */
	close(): Promise<void>;
	/**
	 * Closes and removes any warm symbol index (e.g. an LSP subprocess) not used within
	 * maxIdleMs. Returns the number reaped. Wired into the daemon's periodic maintenance --
	 * a long-lived, dynamic-workspace daemon that has touched many different projects over
	 * its uptime must not keep every one of their warm indexes alive forever (Oculus's own
	 * TTL-eviction lesson: idle LSP servers are a real, unbounded resource-growth risk, not
	 * a theoretical one).
	 */
	reapIdleSymbolIndexes(maxIdleMs: number): Promise<number>;
}

interface RegisteredWorkspace {
	readonly port: WorkspacePort;
	/** Present only for workspaces registered via workspace.registerPath -- required for symbol queries. */
	readonly rootPath?: string;
}

type MutableRegistry = Map<WorkspaceId, RegisteredWorkspace>;

/** A SymbolIndexPort the service can also shut down when it stops. */
export type ClosableSymbolIndex = SymbolIndexPort & { close(): Promise<void> };

export interface LectorServiceOptions {
	/** Factory for the symbol index backing workspace.findSymbols. Defaults to TypescriptSymbolIndex. */
	createSymbolIndex?: (rootPath: string, seedFile?: string) => ClosableSymbolIndex;
	/**
	 * Explicit opt-in to start with zero registered workspaces, relying entirely on
	 * workspace.registerPath at runtime -- the shape a long-lived background daemon that
	 * attaches to whatever project a host adapter (pi-lector) is used from actually needs,
	 * since workspace.registerPath already validates its own explicit absolute path (no
	 * implicit fallback reappears just because the registry started empty). Without this,
	 * zero workspaces at construction is still refused (Locus LCS-BUG-88 class): the default
	 * stays "fail loud on likely misconfiguration," and a caller must say what it actually
	 * intends rather than the guard being silently loosened for everyone.
	 */
	allowDynamicOnly?: boolean;
}

function resolveWorkspace(registry: MutableRegistry, workspaceId: WorkspaceId): WorkspacePort {
	const entry = registry.get(workspaceId);
	if (!entry) throw new UnknownWorkspace(workspaceId);
	return entry.port;
}

/** True when a warm SymbolIndexPort is also a real CodeIntelligencePort (currently: any TypescriptSymbolIndex, never TreeSitterSymbolIndex). */
function supportsCodeIntelligence(index: SymbolIndexPort): index is SymbolIndexPort & CodeIntelligencePort {
	return typeof (index as Partial<CodeIntelligencePort>).goToDefinition === "function";
}

type OperationHandlers = {
	[Name in OperationName]: (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
};

async function registerPath(registry: MutableRegistry, input: OperationInputs["workspace.registerPath"]): Promise<OperationOutputs["workspace.registerPath"]> {
	const absolutePath = resolve(input.path);
	const workspaceId = deriveWorkspaceId(absolutePath);
	if (registry.has(workspaceId)) {
		return { workspaceId, created: false };
	}

	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(absolutePath);
	} catch {
		throw new InvalidWorkspaceRoot(absolutePath, "path does not exist or is not accessible");
	}
	if (!stats.isDirectory()) {
		throw new InvalidWorkspaceRoot(absolutePath, "path is not a directory");
	}

	registry.set(workspaceId, { port: new LocalFilesystemWorkspace(absolutePath), rootPath: absolutePath });
	return { workspaceId, created: true };
}

/**
 * Create the Lector service over an explicit initial registry of workspaces.
 * Refuses to start with zero registered workspaces -- fails loudly at
 * construction (before the daemon ever binds a listener) rather than
 * starting and returning empty/error results per call later.
 * (Locus LCS-BUG-88 class.) The registry grows at runtime only through
 * workspace.registerPath; there is still no operation that guesses a target
 * from anything other than an explicit id or an explicit path.
 */
export function createLectorService(workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>, options: LectorServiceOptions = {}): LectorService {
	if (workspaces.size === 0 && !options.allowDynamicOnly) {
		throw new Error(
			"Lector service requires at least one registered workspace; refusing to start with none " +
				"(pass options.allowDynamicOnly if this daemon intentionally registers workspaces only via workspace.registerPath at runtime)",
		);
	}
	const registry: MutableRegistry = new Map(Array.from(workspaces, ([id, port]) => [id, { port }]));

	// One warm symbol index per workspace, reused across calls -- a fresh process per
	// query would pay a fork+initialize cost every time. Keyed by workspaceId, never by
	// seedFile: a workspace's index warms once.
	// lastUsedAt backs reapIdleSymbolIndexes -- an idle-eviction TTL, not just a warm cache.
	const symbolIndexes = new Map<WorkspaceId, { index: ClosableSymbolIndex; lastUsedAt: number }>();
	const createSymbolIndex = options.createSymbolIndex ?? ((rootPath: string, seedFile?: string) => new TypescriptSymbolIndex(rootPath, seedFile));

	async function ensureWarmIndex(input: { workspaceId: WorkspaceId; seedFile?: string }): Promise<ClosableSymbolIndex> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);

		let entryIndex = symbolIndexes.get(input.workspaceId);
		if (!entryIndex) {
			entryIndex = { index: createSymbolIndex(entry.rootPath, input.seedFile), lastUsedAt: Date.now() };
			symbolIndexes.set(input.workspaceId, entryIndex);
		} else {
			entryIndex.lastUsedAt = Date.now();
		}
		return entryIndex.index;
	}

	async function findSymbols(registry: MutableRegistry, input: OperationInputs["workspace.findSymbols"]): Promise<OperationOutputs["workspace.findSymbols"]> {
		const index = await ensureWarmIndex(input);
		const symbols = await findWorkspaceSymbols(index, input.query);
		return { symbols };
	}

	async function requireCodeIntelligence(input: { workspaceId: WorkspaceId }): Promise<SymbolIndexPort & CodeIntelligencePort> {
		const index = await ensureWarmIndex(input);
		if (!supportsCodeIntelligence(index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
		return index;
	}

	async function goToDefinition(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.goToDefinition"],
	): Promise<OperationOutputs["workspace.goToDefinition"]> {
		const index = await requireCodeIntelligence(input);
		const locations = await goToDefinitionQuery(index, { path: input.path, line: input.line, character: input.character });
		return { locations };
	}

	async function findReferences(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.findReferences"],
	): Promise<OperationOutputs["workspace.findReferences"]> {
		const index = await requireCodeIntelligence(input);
		const locations = await findReferencesQuery(index, { path: input.path, line: input.line, character: input.character }, input.includeDeclaration);
		return { locations };
	}

	async function hover(_registry: MutableRegistry, input: OperationInputs["workspace.hover"]): Promise<OperationOutputs["workspace.hover"]> {
		const index = await requireCodeIntelligence(input);
		const hover = await hoverAt(index, { path: input.path, line: input.line, character: input.character });
		return { hover };
	}

	async function documentSymbolsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.documentSymbols"],
	): Promise<OperationOutputs["workspace.documentSymbols"]> {
		const index = await requireCodeIntelligence(input);
		const symbols = await documentSymbolsQuery(index, input.path);
		return { symbols };
	}

	async function diagnosticsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.diagnostics"],
	): Promise<OperationOutputs["workspace.diagnostics"]> {
		const index = await requireCodeIntelligence(input);
		const diagnostics = await diagnosticsQuery(index, input.path);
		return { diagnostics };
	}

	async function prepareCallHierarchyHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.prepareCallHierarchy"],
	): Promise<OperationOutputs["workspace.prepareCallHierarchy"]> {
		const index = await requireCodeIntelligence(input);
		const items = await prepareCallHierarchyQuery(index, { path: input.path, line: input.line, character: input.character });
		return { items };
	}

	async function incomingCallsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.incomingCalls"],
	): Promise<OperationOutputs["workspace.incomingCalls"]> {
		const index = await requireCodeIntelligence(input);
		const calls = await incomingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
		return { calls };
	}

	async function outgoingCallsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.outgoingCalls"],
	): Promise<OperationOutputs["workspace.outgoingCalls"]> {
		const index = await requireCodeIntelligence(input);
		const calls = await outgoingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
		return { calls };
	}

	const handlers: OperationHandlers = {
		"workspace.rawRead": (registry, input) => rawRead(resolveWorkspace(registry, input.workspaceId), input.path),
		"workspace.exactEdit": (registry, input) => {
			const { workspaceId, ...edit } = input;
			return exactEdit(resolveWorkspace(registry, workspaceId), edit);
		},
		"workspace.registerPath": registerPath,
		"workspace.findSymbols": findSymbols,
		"workspace.goToDefinition": goToDefinition,
		"workspace.findReferences": findReferences,
		"workspace.hover": hover,
		"workspace.documentSymbols": documentSymbolsHandler,
		"workspace.diagnostics": diagnosticsHandler,
		"workspace.prepareCallHierarchy": prepareCallHierarchyHandler,
		"workspace.incomingCalls": incomingCallsHandler,
		"workspace.outgoingCalls": outgoingCallsHandler,
	};

	return {
		operations: OPERATION_NAMES,
		// Declared `async` deliberately, not just typed `Promise<...>`: a handler (e.g.
		// resolveWorkspace's UnknownWorkspace) can throw synchronously, and only an `async`
		// function body converts a synchronous throw into a rejected promise automatically.
		// Without it, `dispatch` would sometimes throw and sometimes reject depending on
		// which operation ran -- a broken contract for any in-process caller (standalone
		// mode, a future Alef adapter) that isn't protected by the HTTP layer's try/catch.
		async dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			const handler = handlers[operation] as (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
			return handler(registry, input);
		},
		async close(): Promise<void> {
			const entries = Array.from(symbolIndexes.values());
			symbolIndexes.clear();
			await Promise.all(entries.map((entry) => entry.index.close()));
		},
		async reapIdleSymbolIndexes(maxIdleMs: number): Promise<number> {
			const now = Date.now();
			const idle = Array.from(symbolIndexes.entries()).filter(([, entry]) => now - entry.lastUsedAt > maxIdleMs);
			for (const [workspaceId] of idle) symbolIndexes.delete(workspaceId);
			await Promise.all(idle.map(([, entry]) => entry.index.close()));
			return idle.length;
		},
	};
}

export { StaleExpectedHash, WorkspaceEntryNotFound };
