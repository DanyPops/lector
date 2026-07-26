import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { FallbackCodeIntelligenceIndex } from "./adapters/fallback-code-intelligence-index.ts";
import { InMemorySearchCache } from "./adapters/in-memory-search-cache.ts";
import { InMemorySymbolGraph } from "./adapters/in-memory-symbol-graph.ts";
import { LocalFilesystemWorkspace } from "./adapters/local-filesystem-workspace.ts";
import { LocalGit } from "./adapters/local-git.ts";
import { discoverWorkspaceDescriptor } from "./adapters/lsp/discover-seed-file.ts";
import { LspSymbolIndex } from "./adapters/lsp/lsp-symbol-index.ts";
import { NpmLockfileVersionResolver } from "./adapters/npm-lockfile-version-resolver.ts";
import { NpmPackageSourceResolver } from "./adapters/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "./adapters/npm-registry-client.ts";
import { ReadOnlyWorkspace } from "./adapters/read-only-workspace.ts";
import { RipgrepTextSearch } from "./adapters/ripgrep-text-search.ts";
import { deriveSourceManifest } from "./adapters/source-manifest.ts";
import { TreeSitterSymbolIndex } from "./adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "./adapters/typescript-compiler-symbol-index.ts";
import { BoundedJobExecutor, type JobSnapshot } from "./domain/bounded-job-executor.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./domain/call-hierarchy.ts";
import type { Diagnostic } from "./domain/diagnostic.ts";
import { diagnostics as diagnosticsQuery } from "./domain/diagnostics.ts";
import type { DocumentSymbolEntry } from "./domain/document-symbol.ts";
import { documentSymbols as documentSymbolsQuery } from "./domain/document-symbols.ts";
import { type EditOutcome, type ExpectedHashEdit, exactEdit, StaleExpectedHash } from "./domain/exact-edit.ts";
import { findReferences as findReferencesQuery } from "./domain/find-references.ts";
import { findWorkspaceSymbols } from "./domain/find-workspace-symbols.ts";
import type { GitDiffResult } from "./domain/git-diff-result.ts";
import type { GitLogEntry } from "./domain/git-log-entry.ts";
import type { GitStatusSummary } from "./domain/git-status.ts";
import { goToDefinition as goToDefinitionQuery } from "./domain/go-to-definition.ts";
import { goToImplementation as goToImplementationQuery } from "./domain/go-to-implementation.ts";
import type { Hover } from "./domain/hover.ts";
import { hoverAt } from "./domain/hover-at.ts";
import { incomingCalls as incomingCallsQuery } from "./domain/incoming-calls.ts";
import type { IntelligenceProvenance } from "./domain/intelligence-provenance.ts";
import { descriptorForPath, LANGUAGE_SERVER_DESCRIPTORS, type LanguageServerDescriptor } from "./domain/language-server-descriptor.ts";
import { outgoingCalls as outgoingCallsQuery } from "./domain/outgoing-calls.ts";
import type { PackageSourceBounds, PackageSourceOperationResult, PackageSourceRequest } from "./domain/package-source.ts";
import { type PopulateSymbolGraphResult, populateSymbolGraph as populateSymbolGraphQuery } from "./domain/populate-symbol-graph.ts";
import { prepareCallHierarchy as prepareCallHierarchyQuery } from "./domain/prepare-call-hierarchy.ts";
import { raceWorkspaceQuery } from "./domain/race-workspace-query.ts";
import { type RawRead, rawRead, WorkspaceEntryNotFound } from "./domain/raw-read.ts";
import { reachableSymbolsFrom } from "./domain/reachable-symbols-from.ts";
import type { RepoFetchResult } from "./domain/repo-fetch-result.ts";
import type { RepoReference } from "./domain/repo-reference.ts";
import { resolvePackageSource } from "./domain/resolve-package-source.ts";
import { searchText as searchTextQuery } from "./domain/search-text.ts";
import { symbolEdgesFrom } from "./domain/symbol-edges-from.ts";
import { symbolEdgesTo } from "./domain/symbol-edges-to.ts";
import type { WorkspaceCacheStatus } from "./domain/symbol-graph-generation.ts";
import { deriveSymbolNodeId } from "./domain/symbol-node-id.ts";
import { assertBoundedSymbolQuery } from "./domain/symbol-query.ts";
import type { TextSearchResult } from "./domain/text-search-result.ts";
import type { WorkspaceQueryOutcome } from "./domain/workspace-query-outcome.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "./domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "./ports/code-intelligence-port.ts";
import type { GitPort } from "./ports/git-port.ts";
import type { PackageSourceResolverPort } from "./ports/package-source-resolver-port.ts";
import type { RepoFetcherPort } from "./ports/repo-fetcher-port.ts";
import type { SearchCachePort } from "./ports/search-cache-port.ts";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "./ports/symbol-graph-port.ts";
import type { SymbolIndexPort } from "./ports/symbol-index-port.ts";
import type { TextSearchPort } from "./ports/text-search-port.ts";
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

/** Raised when a git operation targets a workspace whose root is not inside a git repository -- a real, expected case, not every registered workspace is one. */
export class NotAGitRepository extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" is not inside a git repository`);
		this.name = "NotAGitRepository";
	}
}

/** Raised when a file's extension (or, with no path/seedFile at all, the whole workspace) matches none of Lector's known LanguageServerDescriptors. */
export class UnsupportedLanguage extends Error {
	constructor(readonly hint: string) {
		super(`no supported language server for "${hint}" -- known extensions: ${LANGUAGE_SERVER_DESCRIPTORS.flatMap((d) => d.extensions).join(", ")}`);
		this.name = "UnsupportedLanguage";
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

/** Raised when repo.fetch is called on a service constructed without a createRepoFetcher option -- fetching an external repo needs a real disk location a host must explicitly provide, unlike e.g. createSymbolGraph's safe in-memory default. */
export class RepoFetcherNotConfigured extends Error {
	constructor() {
		super("repo.fetch requires a service constructed with options.createRepoFetcher");
		this.name = "RepoFetcherNotConfigured";
	}
}

export class PackageSourceResolverNotConfigured extends Error {
	constructor() {
		super("package.resolveSource requires a service constructed with repository fetching");
		this.name = "PackageSourceResolverNotConfigured";
	}
}

export class UnsupportedJobOperation extends Error {
	constructor(readonly operation: string) {
		super(`operation "${operation}" cannot run as a background job; supported operations: workspace.populateSymbolGraph`);
		this.name = "UnsupportedJobOperation";
	}
}

export class InvalidJobInput extends Error {
	constructor(reason: string) {
		super(`invalid background job input: ${reason}`);
		this.name = "InvalidJobInput";
	}
}

export class WorkspaceChangedDuringPopulation extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(
			`workspace "${workspaceId}" changed while its symbol graph was being populated; no cached generation was recorded -- retry against a stable source tree`,
		);
		this.name = "WorkspaceChangedDuringPopulation";
	}
}

export class JobWaitTooLong extends Error {
	constructor(
		readonly waitMs: number,
		readonly maxWaitMs: number,
	) {
		super(`background job initial wait ${waitMs}ms exceeds the ${maxWaitMs}ms service bound; submit with a shorter wait and poll job.status`);
		this.name = "JobWaitTooLong";
	}
}

export type OperationName =
	| "workspace.rawRead"
	| "workspace.exactEdit"
	| "workspace.registerPath"
	| "workspace.findSymbols"
	| "workspace.goToDefinition"
	| "workspace.goToImplementation"
	| "workspace.findReferences"
	| "workspace.hover"
	| "workspace.documentSymbols"
	| "workspace.diagnostics"
	| "workspace.prepareCallHierarchy"
	| "workspace.incomingCalls"
	| "workspace.outgoingCalls"
	| "workspace.populateSymbolGraph"
	| "workspace.reachableFrom"
	| "workspace.symbolEdgesFrom"
	| "workspace.symbolEdgesTo"
	| "workspace.hasWarmIndex"
	| "workspace.cacheStatus"
	| "workspace.gitStatus"
	| "workspace.gitLog"
	| "workspace.gitDiff"
	| "repo.fetch"
	| "package.resolveSource"
	| "workspace.searchText"
	| "search.symbols"
	| "search.text"
	| "job.submit"
	| "job.status";

export const OPERATION_NAMES: readonly OperationName[] = [
	"workspace.rawRead",
	"workspace.exactEdit",
	"workspace.registerPath",
	"workspace.findSymbols",
	"workspace.goToDefinition",
	"workspace.goToImplementation",
	"workspace.findReferences",
	"workspace.hover",
	"workspace.documentSymbols",
	"workspace.diagnostics",
	"workspace.prepareCallHierarchy",
	"workspace.incomingCalls",
	"workspace.outgoingCalls",
	"workspace.populateSymbolGraph",
	"workspace.reachableFrom",
	"workspace.symbolEdgesFrom",
	"workspace.symbolEdgesTo",
	"workspace.hasWarmIndex",
	"workspace.cacheStatus",
	"workspace.gitStatus",
	"workspace.gitLog",
	"workspace.gitDiff",
	"repo.fetch",
	"package.resolveSource",
	"workspace.searchText",
	"search.symbols",
	"search.text",
	"job.submit",
	"job.status",
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
	"workspace.findSymbols": { workspaceId: WorkspaceId; query: string; seedFile?: string; maxResults?: number };
	"workspace.goToDefinition": WorkspacePosition;
	"workspace.goToImplementation": WorkspacePosition;
	"workspace.findReferences": WorkspacePosition & { includeDeclaration: boolean };
	"workspace.hover": WorkspacePosition;
	"workspace.documentSymbols": { workspaceId: WorkspaceId; path: string };
	"workspace.diagnostics": { workspaceId: WorkspaceId; path: string };
	"workspace.prepareCallHierarchy": WorkspacePosition;
	"workspace.incomingCalls": WorkspacePosition;
	"workspace.outgoingCalls": WorkspacePosition;
	"workspace.populateSymbolGraph": { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
	"workspace.reachableFrom": WorkspacePosition & { maxDepth: number; kind?: SymbolEdgeKind };
	"workspace.symbolEdgesFrom": WorkspacePosition & { kind?: SymbolEdgeKind };
	"workspace.symbolEdgesTo": WorkspacePosition & { kind?: SymbolEdgeKind };
	"workspace.hasWarmIndex": { workspaceId: WorkspaceId; path?: string };
	"workspace.cacheStatus": { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
	"workspace.gitStatus": { workspaceId: WorkspaceId };
	"workspace.gitLog": { workspaceId: WorkspaceId; maxCount: number };
	"workspace.gitDiff": { workspaceId: WorkspaceId; ref?: string; maxBytes: number };
	"repo.fetch": RepoReference;
	"package.resolveSource": { request: PackageSourceRequest; bounds: PackageSourceBounds };
	"workspace.searchText": { workspaceId: WorkspaceId; query: string; maxMatches: number; maxBytes: number };
	/**
	 * No single workspaceId -- fans out across several at once, unlike every other findSymbols-
	 * shaped operation. `workspaceIds`, when given, restricts the fan-out to exactly those
	 * (each validated -- an unknown id is reported per-entry, not silently dropped). Omitted
	 * defaults to every currently-registered workspace -- found live, not assumed: this daemon is
	 * a shared, system-wide service, so "every registered workspace" can include projects an
	 * entirely different, concurrent Pi session registered, not just this caller's own. A caller
	 * that means "my own current projects" must say so explicitly.
	 */
	"search.symbols": { query: string; workspaceIds?: readonly WorkspaceId[]; timeoutMs?: number };
	"search.text": { query: string; maxMatches: number; maxBytes: number; workspaceIds?: readonly WorkspaceId[]; timeoutMs?: number };
	"job.submit": {
		operation: "workspace.populateSymbolGraph";
		input: { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
		/** Bounded wait before returning the current snapshot. Zero/omitted always returns immediately. */
		waitMs?: number;
	};
	"job.status": { jobId: string };
}

type Provenanced<T> = T & { readonly provenance: IntelligenceProvenance };

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
	"workspace.registerPath": { workspaceId: WorkspaceId; created: boolean };
	"workspace.findSymbols": SymbolSearchResult;
	"workspace.goToDefinition": Provenanced<{ locations: readonly WorkspaceLocation[] }>;
	"workspace.goToImplementation": Provenanced<{ locations: readonly WorkspaceLocation[] }>;
	"workspace.findReferences": Provenanced<{ locations: readonly WorkspaceLocation[] }>;
	"workspace.hover": Provenanced<{ hover: Hover | undefined }>;
	"workspace.documentSymbols": Provenanced<{ symbols: readonly DocumentSymbolEntry[] }>;
	"workspace.diagnostics": Provenanced<{ diagnostics: readonly Diagnostic[] }>;
	"workspace.prepareCallHierarchy": Provenanced<{ items: readonly CallHierarchyEntry[] }>;
	"workspace.incomingCalls": Provenanced<{ calls: readonly IncomingCall[] }>;
	"workspace.outgoingCalls": Provenanced<{ calls: readonly OutgoingCall[] }>;
	"workspace.populateSymbolGraph": { filesProcessed: number; symbolsProcessed: number; nodesAdded: number; edgesAdded: number };
	"workspace.reachableFrom": { symbols: readonly SymbolNode[] };
	"workspace.symbolEdgesFrom": { symbols: readonly SymbolNode[] };
	"workspace.symbolEdgesTo": { symbols: readonly SymbolNode[] };
	"workspace.hasWarmIndex": { warm: boolean };
	"workspace.cacheStatus": WorkspaceCacheStatus;
	"workspace.gitStatus": GitStatusSummary;
	"workspace.gitLog": { entries: readonly GitLogEntry[] };
	"workspace.gitDiff": GitDiffResult;
	"repo.fetch": RepoFetchResult & { workspaceId: WorkspaceId };
	"package.resolveSource": PackageSourceOperationResult;
	"workspace.searchText": TextSearchResult;
	"search.symbols": { results: readonly WorkspaceQueryOutcome<SymbolSearchResult>[] };
	"search.text": { results: readonly WorkspaceQueryOutcome<TextSearchResult>[] };
	"job.submit": { job: JobSnapshot<PopulateSymbolGraphResult> };
	"job.status": { job: JobSnapshot<PopulateSymbolGraphResult> };
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
	/** Local work always outranks disposable fetched-repo work in the bounded job queue. */
	readonly origin: "local" | "remote";
}

type MutableRegistry = Map<WorkspaceId, RegisteredWorkspace>;

/** A SymbolIndexPort the service can also shut down when it stops. */
export type ClosableSymbolIndex = SymbolIndexPort & { close(): Promise<void> };

export interface LectorServiceOptions {
	/** Factory for the symbol index backing workspace.findSymbols and code intelligence, given the descriptor resolved for the call. Defaults to an LspSymbolIndex configured for whichever descriptor is passed. */
	createSymbolIndex?: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
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
	/** Factory for the graph backing workspace.populateSymbolGraph/reachableFrom/symbolEdgesFrom/symbolEdgesTo. Defaults to an in-memory graph (not durable across a restart). */
	createSymbolGraph?: (workspaceId: WorkspaceId) => SymbolGraphPort;
	/** Factory for the git port backing workspace.gitStatus/gitLog/gitDiff. Defaults to LocalGit, the real `git` CLI. Cheap to construct -- never cached, unlike symbol indexes. */
	createGitPort?: (rootPath: string) => GitPort;
	/** Factory for the port backing repo.fetch. No default -- unlike createSymbolGraph's safe in-memory fallback, fetching a real external repo always needs a real disk location only a host (daemon.ts) can supply. Called once at construction and reused, not per-call. */
	createRepoFetcher?: () => RepoFetcherPort;
	/** Override package-source resolution. With a repo fetcher configured, the default composes npm lockfiles, registry metadata, and exact Git fetching. */
	createPackageSourceResolver?: () => PackageSourceResolverPort;
	/** Factory for the port backing workspace.searchText. Defaults to RipgrepTextSearch -- cheap to construct, no disk dependency, safe like createGitPort's default. Called once at construction and reused. */
	createTextSearch?: () => TextSearchPort;
	/** Factory for workspace.searchText's result cache. Defaults to an in-memory-only InMemorySearchCache -- safe, no disk dependency. A host wanting the disk-backed tier too (surviving a restart) supplies a TieredSearchCache here. Called once at construction and reused. */
	createSearchCache?: () => SearchCachePort;
	/** Process-lifetime background executor. Tests inject deterministic ids and tighter bounds. */
	createJobExecutor?: () => BoundedJobExecutor<PopulateSymbolGraphResult>;
}

function resolveWorkspace(registry: MutableRegistry, workspaceId: WorkspaceId): WorkspacePort {
	const entry = registry.get(workspaceId);
	if (!entry) throw new UnknownWorkspace(workspaceId);
	return entry.port;
}

/** True when a warm SymbolIndexPort is also a real CodeIntelligencePort (currently: any LspSymbolIndex, never TreeSitterSymbolIndex). */
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

	registry.set(workspaceId, { port: new LocalFilesystemWorkspace(absolutePath), rootPath: absolutePath, origin: "local" });
	return { workspaceId, created: true };
}

/**
 * How long search.symbols/search.text wait for one workspace's own query before reporting it as
 * "loading" and moving on -- generous enough for typical cold-start (TypeScript/Python/Go/C++/
 * Bash/YAML all settle well under 3s; only rust-analyzer's own measured ~2.5s worst case comes
 * close), bounded so one slow workspace can't stall every other workspace's real results.
 */
const DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS = 3000;
const MAX_INITIAL_JOB_WAIT_MS = 30_000;
const MAX_SYMBOL_RESULTS = 5_000;
const MAX_SOURCE_MANIFEST_BYTES = 50 * 1024 * 1024;

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
	const registry: MutableRegistry = new Map(Array.from(workspaces, ([id, port]) => [id, { port, origin: "local" as const }]));
	let nextJobId = 0;
	const jobs =
		options.createJobExecutor?.() ??
		new BoundedJobExecutor<PopulateSymbolGraphResult>({
			maxConcurrent: 2,
			maxQueued: 32,
			maxRetained: 128,
			retentionMs: 10 * 60 * 1000,
			createId: () => `job-${Date.now().toString(36)}-${(++nextJobId).toString(36)}`,
		});

	// One warm symbol index per (workspace, language) actually queried, reused across calls --
	// a fresh process per query would pay a fork+initialize cost every time. A polyglot
	// workspace holds one warm index per language touched, never one guessed for the whole tree.
	// lastUsedAt backs reapIdleSymbolIndexes -- an idle-eviction TTL, not just a warm cache.
	const symbolIndexes = new Map<string, { index: ClosableSymbolIndex; workspaceId: WorkspaceId; lastUsedAt: number }>();
	const createSymbolIndex =
		options.createSymbolIndex ??
		((rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => {
			const semantic = new LspSymbolIndex(rootPath, descriptor, seedFile);
			if (descriptor.languageId !== "typescript") return semantic;
			return new FallbackCodeIntelligenceIndex(semantic, [new TypeScriptCompilerSymbolIndex(rootPath), new TreeSitterSymbolIndex(rootPath)]);
		});
	function symbolIndexKey(workspaceId: WorkspaceId, languageId: string): string {
		return `${workspaceId}:${languageId}`;
	}

	// One symbol graph per workspace, populated only when workspace.populateSymbolGraph is
	// actually invoked -- unlike symbolIndexes, there is no idle-eviction TTL here: a graph
	// is inert data, not a warm subprocess with a real resource cost while sitting unused.
	const symbolGraphs = new Map<WorkspaceId, SymbolGraphPort>();
	const activePopulationJobByWorkspace = new Map<WorkspaceId, string>();
	const createSymbolGraph = options.createSymbolGraph ?? (() => new InMemorySymbolGraph());

	function ensureSymbolGraph(workspaceId: WorkspaceId): SymbolGraphPort {
		let graph = symbolGraphs.get(workspaceId);
		if (!graph) {
			graph = createSymbolGraph(workspaceId);
			symbolGraphs.set(workspaceId, graph);
		}
		return graph;
	}

	const createGitPort = options.createGitPort ?? ((rootPath: string) => new LocalGit(rootPath));
	// Constructed once, not per-call -- reconstructing would rehydrate the same on-disk index
	// every time, wastefully, and would risk losing the in-memory LRU's recency ordering
	// between calls for no benefit (the index itself is what makes rehydration correct at all).
	const repoFetcher = options.createRepoFetcher?.();
	const packageSourceResolver =
		options.createPackageSourceResolver?.() ??
		(repoFetcher
			? new NpmPackageSourceResolver({ versions: new NpmLockfileVersionResolver(), registry: new NpmRegistryClient(), repositories: repoFetcher })
			: undefined);
	const textSearch = options.createTextSearch?.() ?? new RipgrepTextSearch();
	const searchCache = options.createSearchCache?.() ?? new InMemorySearchCache();

	/** Never cached: cheap to construct, and a stale-git-repo check would be wrong to memoize across a repo that could be git-init'd or removed mid-session. */
	async function requireGitRepository(workspaceId: WorkspaceId): Promise<GitPort> {
		const entry = registry.get(workspaceId);
		if (!entry) throw new UnknownWorkspace(workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(workspaceId);
		const git = createGitPort(entry.rootPath);
		if (!(await git.isGitRepository())) throw new NotAGitRepository(workspaceId);
		return git;
	}

	async function gitStatusHandler(_registry: MutableRegistry, input: OperationInputs["workspace.gitStatus"]): Promise<OperationOutputs["workspace.gitStatus"]> {
		const git = await requireGitRepository(input.workspaceId);
		return git.status();
	}

	async function gitLogHandler(_registry: MutableRegistry, input: OperationInputs["workspace.gitLog"]): Promise<OperationOutputs["workspace.gitLog"]> {
		const git = await requireGitRepository(input.workspaceId);
		return { entries: await git.log(input.maxCount) };
	}

	async function gitDiffHandler(_registry: MutableRegistry, input: OperationInputs["workspace.gitDiff"]): Promise<OperationOutputs["workspace.gitDiff"]> {
		const git = await requireGitRepository(input.workspaceId);
		return git.diff(input.ref, input.maxBytes);
	}

	/** Fetches (or reuses a cached clone of) an external repo and registers it read-only -- the same registry every other operation already reads from, so find_symbols/go_to_definition/git status etc. work on it unchanged once fetched. */
	async function repoFetchHandler(registry: MutableRegistry, input: OperationInputs["repo.fetch"]): Promise<OperationOutputs["repo.fetch"]> {
		if (!repoFetcher) throw new RepoFetcherNotConfigured();
		const result = await repoFetcher.fetch(input);
		const absolutePath = resolve(result.path);
		const workspaceId = deriveWorkspaceId(absolutePath);
		if (!registry.has(workspaceId)) {
			registry.set(workspaceId, { port: new ReadOnlyWorkspace(new LocalFilesystemWorkspace(absolutePath)), rootPath: absolutePath, origin: "remote" });
		}
		return { workspaceId, ...result };
	}

	async function packageSourceHandler(
		registry: MutableRegistry,
		input: OperationInputs["package.resolveSource"],
	): Promise<OperationOutputs["package.resolveSource"]> {
		if (!packageSourceResolver) throw new PackageSourceResolverNotConfigured();
		const outcome = await resolvePackageSource(packageSourceResolver, input.request, input.bounds);
		if (outcome.status !== "verified") return { outcome, workspaceId: null };
		const absolutePath = resolve(outcome.workspace.cachePath);
		let sourceStats: Awaited<ReturnType<typeof stat>>;
		try {
			sourceStats = await stat(absolutePath);
		} catch {
			throw new InvalidWorkspaceRoot(absolutePath, "verified package source does not exist or is not accessible");
		}
		if (!sourceStats.isDirectory()) throw new InvalidWorkspaceRoot(absolutePath, "verified package source is not a directory");
		const workspaceId = deriveWorkspaceId(absolutePath);
		if (!registry.has(workspaceId)) {
			registry.set(workspaceId, { port: new ReadOnlyWorkspace(new LocalFilesystemWorkspace(absolutePath)), rootPath: absolutePath, origin: "remote" });
		}
		return { outcome, workspaceId };
	}

	async function searchTextHandler(
		registry: MutableRegistry,
		input: OperationInputs["workspace.searchText"],
	): Promise<OperationOutputs["workspace.searchText"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		return searchTextQuery(textSearch, searchCache, entry.rootPath, input.workspaceId, input.query, { maxMatches: input.maxMatches, maxBytes: input.maxBytes });
	}

	/** Every workspace with a known root -- the same precondition workspace.findSymbols/searchText already require individually, applied to all of them at once. */
	function registeredWorkspaceIds(registry: MutableRegistry): readonly WorkspaceId[] {
		return Array.from(registry.entries())
			.filter(([, entry]) => entry.rootPath !== undefined)
			.map(([workspaceId]) => workspaceId);
	}

	/**
	 * `explicitIds` given: validates each one (an unknown id or one with no root path becomes an
	 * immediate "error" outcome, not a silent drop) and searches exactly that set -- nothing more.
	 * `explicitIds` omitted: every registered workspace, daemon-wide. This is the one place that
	 * default is genuinely risky: found live, this daemon is a shared, system-wide service, and
	 * "every registered workspace" can include a project an entirely different, concurrent Pi
	 * session registered. A caller that means "just my own current projects" must pass
	 * explicitIds -- pi-lector's own tools always do.
	 */
	function resolveCrossWorkspaceTargets(
		registry: MutableRegistry,
		explicitIds: readonly WorkspaceId[] | undefined,
	): { targets: readonly WorkspaceId[]; immediateErrors: readonly { workspaceId: WorkspaceId; status: "error"; message: string }[] } {
		if (!explicitIds) return { targets: registeredWorkspaceIds(registry), immediateErrors: [] };
		const targets: WorkspaceId[] = [];
		const immediateErrors: { workspaceId: WorkspaceId; status: "error"; message: string }[] = [];
		for (const workspaceId of explicitIds) {
			const entry = registry.get(workspaceId);
			if (!entry) {
				immediateErrors.push({ workspaceId, status: "error", message: `no workspace registered under id "${workspaceId}"` });
			} else if (!entry.rootPath) {
				immediateErrors.push({
					workspaceId,
					status: "error",
					message: `workspace "${workspaceId}" has no known root path -- cross-workspace search requires workspace.registerPath or repo.fetch`,
				});
			} else {
				targets.push(workspaceId);
			}
		}
		return { targets, immediateErrors };
	}

	async function crossFindSymbols(registry: MutableRegistry, input: OperationInputs["search.symbols"]): Promise<OperationOutputs["search.symbols"]> {
		const timeoutMs = input.timeoutMs ?? DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS;
		const { targets, immediateErrors } = resolveCrossWorkspaceTargets(registry, input.workspaceIds);
		const results = await Promise.all(
			targets.map((workspaceId) =>
				raceWorkspaceQuery(
					workspaceId,
					() => findSymbols(registry, { workspaceId, query: input.query }),
					timeoutMs,
					"this workspace's symbol index is still warming up (a cold-starting language server) -- its data may exist once it finishes; retry shortly",
				),
			),
		);
		return { results: [...immediateErrors, ...results] };
	}

	async function crossSearchText(registry: MutableRegistry, input: OperationInputs["search.text"]): Promise<OperationOutputs["search.text"]> {
		const timeoutMs = input.timeoutMs ?? DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS;
		const { targets, immediateErrors } = resolveCrossWorkspaceTargets(registry, input.workspaceIds);
		const results = await Promise.all(
			targets.map((workspaceId) =>
				raceWorkspaceQuery(
					workspaceId,
					() => searchTextHandler(registry, { workspaceId, query: input.query, maxMatches: input.maxMatches, maxBytes: input.maxBytes }),
					timeoutMs,
					"this workspace's search is still running -- its data may exist once it finishes; retry shortly",
				),
			),
		);
		return { results: [...immediateErrors, ...results] };
	}

	/** Resolves which descriptor a call targets: path/seedFile's own extension, per-file like every mainstream editor -- never a guess about "the workspace's language" -- except findSymbols with neither, which has no anchor file at all. */
	function resolveDescriptor(
		rootPath: string,
		hint: { path?: string; seedFile?: string },
	): { descriptor: LanguageServerDescriptor; seedFile: string | undefined } {
		const pathHint = hint.path ?? hint.seedFile;
		if (pathHint) {
			const descriptor = descriptorForPath(pathHint);
			if (!descriptor) throw new UnsupportedLanguage(pathHint);
			return { descriptor, seedFile: hint.seedFile };
		}
		const discovered = discoverWorkspaceDescriptor(rootPath, LANGUAGE_SERVER_DESCRIPTORS);
		if (!discovered) throw new UnsupportedLanguage(rootPath);
		return { descriptor: discovered.descriptor, seedFile: discovered.seedFile };
	}

	async function ensureWarmIndex(input: {
		workspaceId: WorkspaceId;
		path?: string;
		seedFile?: string;
	}): Promise<{ index: ClosableSymbolIndex; descriptor: LanguageServerDescriptor }> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const rootPath = entry.rootPath;

		const { descriptor, seedFile } = resolveDescriptor(rootPath, input);
		const key = symbolIndexKey(input.workspaceId, descriptor.languageId);
		let entryIndex = symbolIndexes.get(key);
		if (!entryIndex) {
			entryIndex = { index: createSymbolIndex(rootPath, descriptor, seedFile), workspaceId: input.workspaceId, lastUsedAt: Date.now() };
			symbolIndexes.set(key, entryIndex);
		} else {
			entryIndex.lastUsedAt = Date.now();
		}
		return { index: entryIndex.index, descriptor };
	}

	/** Never spawns -- a caller deciding whether to enrich a result with LSP-backed info must not pay a cold-start cost just to check. With a path, checks that file's own language; without one, whether anything is warm for the workspace at all. */
	async function hasWarmIndex(
		registry: MutableRegistry,
		input: OperationInputs["workspace.hasWarmIndex"],
	): Promise<OperationOutputs["workspace.hasWarmIndex"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (input.path) {
			const descriptor = descriptorForPath(input.path);
			if (!descriptor) return { warm: false };
			return { warm: symbolIndexes.has(symbolIndexKey(input.workspaceId, descriptor.languageId)) };
		}
		for (const value of symbolIndexes.values()) {
			if (value.workspaceId === input.workspaceId) return { warm: true };
		}
		return { warm: false };
	}

	async function findSymbols(_registry: MutableRegistry, input: OperationInputs["workspace.findSymbols"]): Promise<OperationOutputs["workspace.findSymbols"]> {
		assertBoundedSymbolQuery(input.query);
		const maxResults = input.maxResults ?? 1_000;
		if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SYMBOL_RESULTS) {
			throw new TypeError(`maxResults must be a positive safe integer no greater than ${MAX_SYMBOL_RESULTS}`);
		}
		const { index } = await ensureWarmIndex(input);
		return findWorkspaceSymbols(index, input.query, { maxResults });
	}

	async function requireCodeIntelligence(input: {
		workspaceId: WorkspaceId;
		path?: string;
		seedFile?: string;
	}): Promise<{ index: SymbolIndexPort & CodeIntelligencePort; descriptor: LanguageServerDescriptor }> {
		const { index, descriptor } = await ensureWarmIndex(input);
		if (!supportsCodeIntelligence(index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
		return { index, descriptor };
	}

	async function goToDefinition(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.goToDefinition"],
	): Promise<OperationOutputs["workspace.goToDefinition"]> {
		const { index } = await requireCodeIntelligence(input);
		const locations = await goToDefinitionQuery(index, { path: input.path, line: input.line, character: input.character });
		return { locations, provenance: index.provenance };
	}

	async function goToImplementation(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.goToImplementation"],
	): Promise<OperationOutputs["workspace.goToImplementation"]> {
		const { index } = await requireCodeIntelligence(input);
		const locations = await goToImplementationQuery(index, { path: input.path, line: input.line, character: input.character });
		return { locations, provenance: index.provenance };
	}

	async function findReferences(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.findReferences"],
	): Promise<OperationOutputs["workspace.findReferences"]> {
		const { index } = await requireCodeIntelligence(input);
		const locations = await findReferencesQuery(index, { path: input.path, line: input.line, character: input.character }, input.includeDeclaration);
		return { locations, provenance: index.provenance };
	}

	async function hover(_registry: MutableRegistry, input: OperationInputs["workspace.hover"]): Promise<OperationOutputs["workspace.hover"]> {
		const { index } = await requireCodeIntelligence(input);
		const hover = await hoverAt(index, { path: input.path, line: input.line, character: input.character });
		return { hover, provenance: index.provenance };
	}

	async function documentSymbolsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.documentSymbols"],
	): Promise<OperationOutputs["workspace.documentSymbols"]> {
		const { index } = await requireCodeIntelligence(input);
		const symbols = await documentSymbolsQuery(index, input.path);
		return { symbols, provenance: index.provenance };
	}

	async function diagnosticsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.diagnostics"],
	): Promise<OperationOutputs["workspace.diagnostics"]> {
		const { index } = await requireCodeIntelligence(input);
		const diagnostics = await diagnosticsQuery(index, input.path);
		return { diagnostics, provenance: index.provenance };
	}

	async function prepareCallHierarchyHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.prepareCallHierarchy"],
	): Promise<OperationOutputs["workspace.prepareCallHierarchy"]> {
		const { index } = await requireCodeIntelligence(input);
		const items = await prepareCallHierarchyQuery(index, { path: input.path, line: input.line, character: input.character });
		return { items, provenance: index.provenance };
	}

	async function incomingCallsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.incomingCalls"],
	): Promise<OperationOutputs["workspace.incomingCalls"]> {
		const { index } = await requireCodeIntelligence(input);
		const calls = await incomingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
		return { calls, provenance: index.provenance };
	}

	async function outgoingCallsHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.outgoingCalls"],
	): Promise<OperationOutputs["workspace.outgoingCalls"]> {
		const { index } = await requireCodeIntelligence(input);
		const calls = await outgoingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
		return { calls, provenance: index.provenance };
	}

	async function populateSymbolGraphHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	): Promise<OperationOutputs["workspace.populateSymbolGraph"]> {
		const { index, descriptor } = await requireCodeIntelligence(input);
		const entry = registry.get(input.workspaceId);
		if (!entry?.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const rootPath = entry.rootPath;
		const before = await deriveSourceManifest(rootPath, descriptor.extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);
		const graph = ensureSymbolGraph(input.workspaceId);
		const result = await populateSymbolGraphQuery(index, graph, before.absoluteFiles, input.maxSymbolsPerFile);
		const after = await deriveSourceManifest(rootPath, descriptor.extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);
		if (after.fingerprint !== before.fingerprint) throw new WorkspaceChangedDuringPopulation(input.workspaceId);
		await graph.setGeneration({
			sourceFingerprint: after.fingerprint,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
			completedAt: Date.now(),
			provenance: index.provenance,
			result,
		});
		return result;
	}

	async function cacheStatusHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.cacheStatus"],
	): Promise<OperationOutputs["workspace.cacheStatus"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const activeJobId = activePopulationJobByWorkspace.get(input.workspaceId);
		if (activeJobId) {
			const snapshot = jobs.status(activeJobId);
			if (snapshot.status === "queued" || snapshot.status === "running") return { status: "caching", jobId: activeJobId };
			activePopulationJobByWorkspace.delete(input.workspaceId);
		}
		const graph = ensureSymbolGraph(input.workspaceId);
		const generation = await graph.getGeneration();
		if (!generation) return { status: "not-cached", reason: "no-completed-generation" };
		if (generation.maxFiles !== input.maxFiles || generation.maxSymbolsPerFile !== input.maxSymbolsPerFile) {
			return { status: "not-cached", reason: "bounds-changed" };
		}
		const { descriptor } = resolveDescriptor(entry.rootPath, {});
		let currentFingerprint: string;
		try {
			currentFingerprint = (await deriveSourceManifest(entry.rootPath, descriptor.extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES)).fingerprint;
		} catch {
			return { status: "not-cached", reason: "source-changed" };
		}
		if (currentFingerprint !== generation.sourceFingerprint) return { status: "not-cached", reason: "source-changed" };
		return { status: "cached", generation };
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	async function submitJobHandler(_registry: MutableRegistry, request: OperationInputs["job.submit"]): Promise<OperationOutputs["job.submit"]> {
		const rawRequest: unknown = request;
		if (!isRecord(rawRequest)) throw new InvalidJobInput("request must be an object");
		const operation = rawRequest.operation;
		if (operation !== "workspace.populateSymbolGraph") throw new UnsupportedJobOperation(String(operation));
		const rawInput = rawRequest.input;
		if (!isRecord(rawInput)) throw new InvalidJobInput("input must be an object");
		const { workspaceId, maxFiles, maxSymbolsPerFile } = rawInput;
		if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new InvalidJobInput("workspaceId must be a non-empty string");
		if (typeof maxFiles !== "number" || !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new InvalidJobInput("maxFiles must be a positive safe integer");
		if (typeof maxSymbolsPerFile !== "number" || !Number.isSafeInteger(maxSymbolsPerFile) || maxSymbolsPerFile < 1) {
			throw new InvalidJobInput("maxSymbolsPerFile must be a positive safe integer");
		}
		const rawWaitMs = rawRequest.waitMs;
		const waitMs = rawWaitMs ?? 0;
		if (typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 0) throw new InvalidJobInput("waitMs must be a non-negative safe integer");
		if (waitMs > MAX_INITIAL_JOB_WAIT_MS) throw new JobWaitTooLong(waitMs, MAX_INITIAL_JOB_WAIT_MS);
		const workspace = registry.get(workspaceId);
		if (!workspace) throw new UnknownWorkspace(workspaceId);
		const existingJobId = activePopulationJobByWorkspace.get(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				return { job: waitMs === 0 ? existing : await jobs.wait(existing.id, waitMs) };
			}
			activePopulationJobByWorkspace.delete(workspaceId);
		}
		const input = { workspaceId, maxFiles, maxSymbolsPerFile };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation,
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraphHandler(registry, input);
				} finally {
					if (activePopulationJobByWorkspace.get(workspaceId) === submittedJobId) activePopulationJobByWorkspace.delete(workspaceId);
				}
			},
		});
		submittedJobId = submitted.id;
		activePopulationJobByWorkspace.set(workspaceId, submitted.id);
		return { job: waitMs === 0 ? submitted : await jobs.wait(submitted.id, waitMs) };
	}

	function jobStatusHandler(_registry: MutableRegistry, input: OperationInputs["job.status"]): Promise<OperationOutputs["job.status"]> {
		const rawInput: unknown = input;
		if (!isRecord(rawInput) || typeof rawInput.jobId !== "string" || rawInput.jobId.length === 0) {
			return Promise.reject(new InvalidJobInput("jobId must be a non-empty string"));
		}
		return Promise.resolve({ job: jobs.status(rawInput.jobId) });
	}

	async function reachableFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	): Promise<OperationOutputs["workspace.reachableFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await reachableSymbolsFrom(graph, id, { maxDepth: input.maxDepth, kind: input.kind });
		return { symbols };
	}

	async function symbolEdgesFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	): Promise<OperationOutputs["workspace.symbolEdgesFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesFrom(graph, id, input.kind);
		return { symbols };
	}

	async function symbolEdgesToHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	): Promise<OperationOutputs["workspace.symbolEdgesTo"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesTo(graph, id, input.kind);
		return { symbols };
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
		"workspace.goToImplementation": goToImplementation,
		"workspace.findReferences": findReferences,
		"workspace.hover": hover,
		"workspace.documentSymbols": documentSymbolsHandler,
		"workspace.diagnostics": diagnosticsHandler,
		"workspace.prepareCallHierarchy": prepareCallHierarchyHandler,
		"workspace.incomingCalls": incomingCallsHandler,
		"workspace.outgoingCalls": outgoingCallsHandler,
		"workspace.populateSymbolGraph": populateSymbolGraphHandler,
		"workspace.reachableFrom": reachableFromHandler,
		"workspace.symbolEdgesFrom": symbolEdgesFromHandler,
		"workspace.symbolEdgesTo": symbolEdgesToHandler,
		"workspace.hasWarmIndex": hasWarmIndex,
		"workspace.cacheStatus": cacheStatusHandler,
		"workspace.gitStatus": gitStatusHandler,
		"workspace.gitLog": gitLogHandler,
		"workspace.gitDiff": gitDiffHandler,
		"repo.fetch": repoFetchHandler,
		"package.resolveSource": packageSourceHandler,
		"workspace.searchText": searchTextHandler,
		"search.symbols": crossFindSymbols,
		"search.text": crossSearchText,
		"job.submit": submitJobHandler,
		"job.status": jobStatusHandler,
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
			jobs.close();
			const entries = Array.from(symbolIndexes.values());
			symbolIndexes.clear();
			const graphs = Array.from(symbolGraphs.values());
			symbolGraphs.clear();
			await Promise.all([...entries.map((entry) => entry.index.close()), ...graphs.map((graph) => graph.close())]);
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

export { JobCapacityExceeded, JobNotFound } from "./domain/bounded-job-executor.ts";
export { StaleExpectedHash, WorkspaceEntryNotFound };
