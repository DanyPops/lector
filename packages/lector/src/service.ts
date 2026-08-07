import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { SymbolComparisonStatus } from "./code-intelligence/compare-symbol-declarations.ts";
import type { Diagnostic } from "./code-intelligence/diagnostic.ts";
import type { DocumentSymbolEntry } from "./code-intelligence/document-symbol.ts";
import { FallbackCodeIntelligenceIndex } from "./code-intelligence/fallback-code-intelligence-index.ts";
import type { Hover } from "./code-intelligence/hover.ts";
import type { IntelligenceProvenance } from "./code-intelligence/intelligence-provenance.ts";
import { LANGUAGE_SERVER_DESCRIPTORS, type LanguageServerDescriptor } from "./code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "./code-intelligence/lsp/lsp-symbol-index.ts";
import { TreeSitterSymbolIndex } from "./code-intelligence/tree-sitter/typescript-tree-sitter-symbol-index.ts";
import { TypeScriptCompilerSymbolIndex } from "./code-intelligence/typescript-compiler-symbol-index.ts";
import { BoundedJobExecutor, type JobSnapshot } from "./concurrency/bounded-job-executor.ts";
import { SerialExecutionQueue } from "./concurrency/serial-execution-queue.ts";
import { InMemoryContentCache } from "./content-cache/in-memory-content-cache.ts";
import type { ContentCachePort } from "./content-cache/port.ts";
import type { ContentHash } from "./content-identity/content-hash.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "./external-search/external-search-result.ts";
import { InMemoryExternalSearchCache } from "./external-search-cache/in-memory-external-search-cache.ts";
import type { ExternalSearchCachePort } from "./external-search-cache/port.ts";
import { NodeFsFileWatcher } from "./file-watcher/node-fs-file-watcher.ts";
import type { FileWatcherPort } from "./file-watcher/port.ts";
import { WatchLimitExceeded } from "./file-watcher/watch-registry.ts";
import type { GitDiffResult } from "./git/diff-result.ts";
import { LocalGit } from "./git/local-git.ts";
import type { GitLogEntry } from "./git/log-entry.ts";
import type { GitPort } from "./git/port.ts";
import type { GitStatusSummary } from "./git/status.ts";
import { GithubSearchClient } from "./github-search/github-search-client.ts";
import type { GithubSearchPort } from "./github-search/port.ts";
import { NpmLockfileVersionResolver } from "./installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import type { LanguageServerProvisionerPort } from "./lsp-provisioning/port.ts";
import type { MutationHistoryEntry } from "./mutation-history/mutation-history.ts";
import type { MutationHistoryPort } from "./mutation-history/port.ts";
import { NpmPackageSourceResolver } from "./npm-registry/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "./npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "./npm-registry/port.ts";
import { InMemoryPackageSourceIndex } from "./package-source/in-memory-package-source-index.ts";
import type { PackageSourceIndexPort } from "./package-source/index-port.ts";
import type { PackageEcosystem, PackageSourceBounds, PackageSourceOperationResult, PackageSourceRequest } from "./package-source/package-source.ts";
import type { PackageSourceIndexQuery, PackageSourceListEntry } from "./package-source/package-source-index.ts";
import type { PackageSourceResolverPort } from "./package-source/resolver-port.ts";
import { assertAbsolutePath, RelativeWorkspacePath } from "./path-safety/assert-absolute-path.ts";
import type { ReferenceBasedRenameOutcome } from "./reference-based-rename/apply-reference-based-rename.ts";
import type { CachedRepositoryPage, CachedRepositoryQuery } from "./repo-fetcher/cached-repository-entry.ts";
import type { RepoFetcherPort } from "./repo-fetcher/port.ts";
import type { RepoFetchResult } from "./repo-fetcher/repo-fetch-result.ts";
import type { RepoReference } from "./repo-fetcher/repo-reference.ts";
import { InMemorySearchCache } from "./search-cache/in-memory-search-cache.ts";
import type { SearchCachePort } from "./search-cache/port.ts";
import { AnnotationHandlers } from "./service/annotation-handlers.ts";
import { createCodeIntelligenceHandlers } from "./service/code-intelligence-handlers.ts";
import { createCrossWorkspaceHandlers } from "./service/cross-workspace-handlers.ts";
import { createExternalSearchHandlers } from "./service/external-search-handlers.ts";
import { createGitHandlers } from "./service/git-handlers.ts";
import { GraphRefreshCoordinator } from "./service/graph-refresh-coordinator.ts";
import { MutationHistoryCoordinator } from "./service/mutation-history-handlers.ts";
import { createPackageSourceHandlers } from "./service/package-source-handlers.ts";
import { createRepoFetchHandlers } from "./service/repo-fetch-handlers.ts";
import { createSymbolGraphHandlers } from "./service/symbol-graph-handlers.ts";
import { type ClosableSymbolIndex, WarmIndexRegistry } from "./service/warm-index-registry.ts";
import { createWorkspaceFileHandlers } from "./service/workspace-file-handlers.ts";
import { createWorkspaceMapHandler } from "./service/workspace-map-handler.ts";
import { WorkspaceWatchHandlers } from "./service/workspace-watch-handlers.ts";
import type { SourcegraphSearchPort } from "./sourcegraph-search/port.ts";
import { SourcegraphSearchClient } from "./sourcegraph-search/sourcegraph-search-client.ts";
import type { SymbolAnnotationPort } from "./symbol-annotation/port.ts";
import type { AnnotationId, SymbolAnnotation } from "./symbol-annotation/symbol-annotation.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./symbol-graph/call-hierarchy.ts";
import { InMemorySymbolGraph } from "./symbol-graph/in-memory-symbol-graph.ts";
import type { PopulateSymbolGraphResult } from "./symbol-graph/populate-symbol-graph.ts";
import type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "./symbol-graph/port.ts";
import type { WorkspaceCacheStatus } from "./symbol-graph/symbol-graph-generation.ts";
import type { FindFilesResult } from "./text-search/find-files-result.ts";
import type { TextSearchPort } from "./text-search/port.ts";
import { RipgrepTextSearch } from "./text-search/ripgrep-text-search.ts";
import type { TextSearchResult } from "./text-search/text-search-result.ts";
import { PatchRejected } from "./workspace/apply-patch.ts";
import { type EditOutcome, type ExpectedHashEdit, StaleExpectedHash } from "./workspace/exact-edit.ts";
import type { FileTreePort } from "./workspace/file-tree-port.ts";
import { type LineEdit, type LineEditOutcome, LineEditRace, LineEditRejected } from "./workspace/line-edit.ts";
import type { DirectoryListing } from "./workspace/list-directory.ts";
import { LocalFilesystemWorkspace } from "./workspace/local-filesystem-workspace.ts";
import type { WorkspacePort } from "./workspace/port.ts";
import { type RawRead, WorkspaceEntryNotFound } from "./workspace/raw-read.ts";
import type { ResponseFormat } from "./workspace/response-format.ts";
import type { RenameRange } from "./workspace/workspace-edit.ts";
import type { WorkspaceMapResult } from "./workspace/workspace-map.ts";
import type { WorkspaceQueryOutcome } from "./workspace/workspace-query-outcome.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "./workspace/workspace-symbol.ts";

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
/** Raised when the negotiated backend has no rename/prepareRename support at all (e.g. a tree-sitter fallback, or a real server that never advertised renameProvider). */
export class RenameNotSupported extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}"'s symbol index does not support rename -- the negotiated backend never advertised renameProvider`);
		this.name = "RenameNotSupported";
	}
}

export class NotAGitRepository extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" is not inside a git repository`);
		this.name = "NotAGitRepository";
	}
}

/**
 * Raised when workspace.compareSymbolAcrossVersions targets a file extension outside
 * Lector's tree-sitter TypeScript/JavaScript grammars -- a narrower list than
 * UnsupportedLanguage's LSP-backed extension set, since this operation's first pass is the
 * syntactic tier only (no real checkout, no project-aware LSP resolution across versions yet).
 */
export class SymbolComparisonUnsupportedLanguage extends Error {
	constructor(readonly extension: string) {
		super(`workspace.compareSymbolAcrossVersions has no tree-sitter grammar for extension "${extension}"`);
		this.name = "SymbolComparisonUnsupportedLanguage";
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

/** Raised when a proposed annotation anchor does not resolve to a real, currently-known symbol node (the graph has no record of it) or the anchor's file does not exist -- an annotation must anchor to symbols Lector actually knows about, never a position asserted on faith. */
export class UnknownAnnotationAnchor extends Error {
	constructor(
		readonly path: string,
		readonly line: number,
		readonly character: number,
	) {
		super(`no known symbol at ${path}:${line}:${character} -- populate the symbol graph first, or check the position`);
		this.name = "UnknownAnnotationAnchor";
	}
}

/** Raised when workspace.createAnnotation/refreshAnnotation is given zero anchors -- an annotation with nothing to invalidate it against is never allowed to exist. */
export class AnnotationRequiresAnchors extends Error {
	constructor() {
		super("an annotation requires at least one anchor");
		this.name = "AnnotationRequiresAnchors";
	}
}

/** Raised when workspace.containAnnotation names a parentId or childId that get() cannot find -- containment is a relation between two real annotations, never asserted on faith. */
export class UnknownAnnotationForContainment extends Error {
	constructor(readonly id: string) {
		super(`no annotation "${id}" -- containment requires both the parent and the child to already exist`);
		this.name = "UnknownAnnotationForContainment";
	}
}

/** Raised when workspace.containAnnotation would create a cycle (a self-loop, or the child can already reach the parent) -- rejected up front, never silently accepted. */
export class AnnotationContainmentCycle extends Error {
	constructor(
		readonly parentId: string,
		readonly childId: string,
	) {
		super(`making "${childId}" a child of "${parentId}" would create a containment cycle`);
		this.name = "AnnotationContainmentCycle";
	}
}

/** Raised when repo.fetch is called on a service constructed without a createRepoFetcher option -- fetching an external repo needs a real disk location a host must explicitly provide, unlike e.g. createSymbolGraph's safe in-memory default. */
export class RepoFetcherNotConfigured extends Error {
	constructor() {
		super("repo.fetch requires a service constructed with options.createRepoFetcher");
		this.name = "RepoFetcherNotConfigured";
	}
}

/** Raised by repo.evictCache when the target cache entry's resolved path is still a currently-registered workspace. There is no workspace.unregister operation, so evicting would delete a live workspace's backing storage out from under every other operation still reading it. */
export class RepoCacheEntryInUse extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`cannot evict: still registered as workspace "${workspaceId}"`);
		this.name = "RepoCacheEntryInUse";
	}
}

export class PackageSourceResolverNotConfigured extends Error {
	constructor() {
		super("package.resolveSource requires a service constructed with repository fetching");
		this.name = "PackageSourceResolverNotConfigured";
	}
}

/** Raised by package.removeSource/cleanSources when the entry's own recorded workspaceId is still a currently-registered workspace. There is no workspace.unregister operation, mirroring RepoCacheEntryInUse's identical limitation for repo.evictCache. */
export class PackageSourceEntryInUse extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`cannot remove: still registered as workspace "${workspaceId}"`);
		this.name = "PackageSourceEntryInUse";
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

/** A revert is only safe when the file's current content is exactly what the targeted mutation itself produced -- anything else (a later edit, a deletion) means reverting now would silently clobber a change this entry never knew about. Matches every other Lector write's own expected-hash-guard discipline. */
export class MutationEntryNotFound extends Error {
	constructor(readonly entryId: string) {
		super(`no mutation history entry "${entryId}" -- it was never recorded, already evicted (bounded history), or belongs to a different workspace`);
		this.name = "MutationEntryNotFound";
	}
}

export class MutationRevertStale extends Error {
	constructor(
		readonly entryId: string,
		readonly path: string,
	) {
		super(`"${path}" has changed since mutation "${entryId}" was applied -- refusing to revert over a change this entry never knew about`);
		this.name = "MutationRevertStale";
	}
}

/** A partial multi-file change scores worse than no change at all -- CodeScaleBench's own finding. Refuses to touch anything rather than rename against a symbol graph that doesn't honestly know every reference yet. */
export class ReferenceBasedRenameRequiresFreshGraph extends Error {
	constructor(
		readonly workspaceId: WorkspaceId,
		readonly status: string,
	) {
		super(
			`workspace "${workspaceId}"'s symbol graph is "${status}", not fully cached -- refusing to rename against an incomplete reference set; populate the graph first`,
		);
		this.name = "ReferenceBasedRenameRequiresFreshGraph";
	}
}

export type JobTopic = string & { readonly __brand: "JobTopic" };
export type JobWatchId = string & { readonly __brand: "JobWatchId" };

export function jobTopicFor(jobId: string): JobTopic {
	// The only constructor for this topic namespace; callers cannot mix arbitrary push topics with job topics.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return `lector.job.${jobId}` as JobTopic;
}

export function jobWatchIdFor(jobId: string): JobWatchId {
	// The only constructor for job-watch ids; a job id cannot be passed where a watch id is required.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return `job-watch:${jobId}` as JobWatchId;
}

export class JobWaitTooLong extends Error {
	constructor(
		readonly waitMs: number,
		readonly maxWaitMs: number,
	) {
		super(
			`background job initial wait ${waitMs}ms exceeds the ${maxWaitMs}ms service bound; submit with a shorter wait and follow completion through job.watch`,
		);
		this.name = "JobWaitTooLong";
	}
}

export type OperationName =
	| "workspace.rawRead"
	| "workspace.exactEdit"
	| "workspace.deleteEntry"
	| "workspace.lineEdit"
	| "workspace.applyPatch"
	| "workspace.mutationHistory"
	| "workspace.revertMutation"
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
	| "workspace.referenceBasedRename"
	| "workspace.prepareRename"
	| "workspace.rename"
	| "workspace.gitStatus"
	| "workspace.gitLog"
	| "workspace.gitDiff"
	| "workspace.compareSymbolAcrossVersions"
	| "repo.fetch"
	| "repo.listCache"
	| "repo.evictCache"
	| "package.resolveSource"
	| "package.listSources"
	| "package.removeSource"
	| "package.cleanSources"
	| "search.githubRepos"
	| "search.npmPackages"
	| "search.sourcegraphCode"
	| "workspace.searchText"
	| "workspace.findFiles"
	| "workspace.watch"
	| "workspace.unwatch"
	| "search.symbols"
	| "search.text"
	| "job.submit"
	| "job.status"
	| "job.watch"
	| "workspace.createAnnotation"
	| "workspace.getAnnotation"
	| "workspace.listAnnotations"
	| "workspace.refreshAnnotation"
	| "workspace.scrubAnnotation"
	| "workspace.restoreAnnotation"
	| "workspace.containAnnotation"
	| "workspace.uncontainAnnotation"
	| "workspace.annotationTree"
	| "workspace.map"
	| "workspace.listDirectory"
	| "workspace.createDirectory"
	| "workspace.renamePath"
	| "workspace.deleteDirectory";

export const OPERATION_NAMES: readonly OperationName[] = [
	"workspace.rawRead",
	"workspace.exactEdit",
	"workspace.deleteEntry",
	"workspace.lineEdit",
	"workspace.applyPatch",
	"workspace.mutationHistory",
	"workspace.revertMutation",
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
	"workspace.referenceBasedRename",
	"workspace.prepareRename",
	"workspace.rename",
	"workspace.gitStatus",
	"workspace.gitLog",
	"workspace.gitDiff",
	"workspace.compareSymbolAcrossVersions",
	"repo.fetch",
	"repo.listCache",
	"repo.evictCache",
	"package.resolveSource",
	"package.listSources",
	"package.removeSource",
	"package.cleanSources",
	"search.githubRepos",
	"search.npmPackages",
	"search.sourcegraphCode",
	"workspace.searchText",
	"workspace.findFiles",
	"workspace.watch",
	"workspace.unwatch",
	"search.symbols",
	"search.text",
	"job.submit",
	"job.status",
	"job.watch",
	"workspace.createAnnotation",
	"workspace.getAnnotation",
	"workspace.listAnnotations",
	"workspace.refreshAnnotation",
	"workspace.scrubAnnotation",
	"workspace.restoreAnnotation",
	"workspace.containAnnotation",
	"workspace.uncontainAnnotation",
	"workspace.annotationTree",
	"workspace.map",
	"workspace.listDirectory",
	"workspace.createDirectory",
	"workspace.renamePath",
	"workspace.deleteDirectory",
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
	"workspace.deleteEntry": { workspaceId: WorkspaceId; path: string; expectedHash: ContentHash };
	"workspace.lineEdit": { workspaceId: WorkspaceId; path: string; edits: readonly LineEdit[] };
	"workspace.applyPatch": { workspaceId: WorkspaceId; path: string; expectedHash: ContentHash; patchText: string };
	"workspace.mutationHistory": { workspaceId: WorkspaceId; path: string; maxResults: number };
	"workspace.revertMutation": { workspaceId: WorkspaceId; entryId: string };
	"workspace.registerPath": { path: string };
	"workspace.listDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.createDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.renamePath": { workspaceId: WorkspaceId; oldPath: string; newPath: string };
	"workspace.deleteDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.findSymbols": { workspaceId: WorkspaceId; query: string; seedFile?: string; maxResults?: number; responseFormat?: ResponseFormat };
	"workspace.goToDefinition": WorkspacePosition;
	"workspace.goToImplementation": WorkspacePosition;
	"workspace.findReferences": WorkspacePosition & { includeDeclaration: boolean; responseFormat?: ResponseFormat };
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
	/** maxFiles/maxSymbolsPerFile gate the same freshness check cacheStatus uses -- this rename refuses outright unless the graph is fully "cached" (never "partial") for those exact bounds. */
	"workspace.referenceBasedRename": { workspaceId: WorkspaceId; fromPath: string; toPath: string; maxFiles: number; maxSymbolsPerFile: number };
	"workspace.prepareRename": WorkspacePosition;
	"workspace.rename": WorkspacePosition & { newName: string };
	"workspace.gitStatus": { workspaceId: WorkspaceId };
	"workspace.gitLog": { workspaceId: WorkspaceId; maxCount: number };
	"workspace.gitDiff": { workspaceId: WorkspaceId; ref?: string; maxBytes: number };
	/** toRef omitted means "the current working tree" -- fromRef is always a real git ref, never optional, since there is always at least one real version to compare from. */
	"workspace.compareSymbolAcrossVersions": { workspaceId: WorkspaceId; path: string; symbolName: string; fromRef: string; toRef?: string; maxBytes: number };
	"repo.fetch": RepoReference & { forceRefresh?: boolean };
	"repo.listCache": CachedRepositoryQuery & { maxResults: number; cursor?: string };
	"repo.evictCache": RepoReference;
	"package.resolveSource": { request: PackageSourceRequest; bounds: PackageSourceBounds };
	/** Every field optional -- an omitted ecosystem/text means "every recorded package source." */
	"package.listSources": PackageSourceIndexQuery & { maxResults: number; cursor?: string };
	"package.removeSource": { ecosystem: PackageEcosystem; registry: string | null; name: string; resolvedVersion: string };
	/** ecosystem omitted means every ecosystem. */
	"package.cleanSources": { ecosystem?: PackageEcosystem };
	/** Explicit-query search only, never open-ended discovery/trending -- results are shaped as direct repo.fetch inputs (host/owner/repo). */
	"search.githubRepos": { query: string; maxResults: number };
	/** Results are shaped as direct package.resolveSource inputs (name, plus the version already returned). */
	"search.npmPackages": { query: string; maxResults: number };
	/** Content search across public GitHub via sourcegraph.com -- a genuinely different discovery mode than the two above (which repos contain X, not which repos/packages match X by name/metadata). Each candidate's repository field feeds repo.fetch once split via splitSourcegraphRepository. */
	"search.sourcegraphCode": { query: string; maxResults: number };
	"workspace.searchText": { workspaceId: WorkspaceId; query: string; maxMatches: number; maxBytes: number };
	/** `patterns` are OR'd together -- a file matching any one of them is included. */
	"workspace.findFiles": { workspaceId: WorkspaceId; patterns: readonly string[]; maxResults: number; maxBytes: number };
	/** Registers a real, ongoing watch for files matching `pattern` under workspaceId, published to the returned topic via the daemon's PushChannel ("/push") going forward. */
	"workspace.watch": { workspaceId: WorkspaceId; pattern: string };
	"workspace.unwatch": { watchId: string };
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
	"job.watch": { jobId: string };
	"workspace.createAnnotation": {
		workspaceId: WorkspaceId;
		subtype: string;
		title: string;
		body: string;
		/** Positions only -- symbolNodeId and the anchor's baseline file hash are derived server-side from the live graph/workspace, never trusted from the caller. */
		anchors: readonly { path: string; line: number; character: number }[];
	};
	"workspace.getAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.listAnnotations": { workspaceId: WorkspaceId; subtype?: string; status?: "fresh" | "stale" | "scrubbed"; maxResults?: number; query?: string };
	"workspace.refreshAnnotation": {
		workspaceId: WorkspaceId;
		id: AnnotationId;
		subtype: string;
		title: string;
		body: string;
		anchors: readonly { path: string; line: number; character: number }[];
	};
	"workspace.scrubAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.restoreAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.containAnnotation": { workspaceId: WorkspaceId; parentId: AnnotationId; childId: AnnotationId };
	"workspace.uncontainAnnotation": { workspaceId: WorkspaceId; parentId: AnnotationId; childId: AnnotationId };
	"workspace.annotationTree": { workspaceId: WorkspaceId; rootId: AnnotationId; maxDepth: number };
	"workspace.map": { workspaceId: WorkspaceId; maxNodes: number; maxEdges: number; maxEntries: number; maxBytes: number };
}

type Provenanced<T> = T & { readonly provenance: IntelligenceProvenance };

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
	"workspace.deleteEntry": { path: string; previousHash: ContentHash | null };
	"workspace.lineEdit": LineEditOutcome;
	"workspace.applyPatch": EditOutcome;
	"workspace.mutationHistory": { entries: readonly MutationHistoryEntry[] };
	/** newHash is null when the reverted-to state is "the file doesn't exist" -- reverting a create back to nonexistence, or reverting a delete when the file has stayed deleted since. */
	"workspace.revertMutation": { path: string; newHash: ContentHash | null };
	"workspace.registerPath": { workspaceId: WorkspaceId; created: boolean };
	"workspace.listDirectory": DirectoryListing;
	"workspace.createDirectory": { path: string };
	"workspace.renamePath": { oldPath: string; newPath: string };
	"workspace.deleteDirectory": { path: string };
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
	"workspace.populateSymbolGraph": PopulateSymbolGraphResult;
	"workspace.reachableFrom": { symbols: readonly SymbolNode[] };
	"workspace.symbolEdgesFrom": { symbols: readonly SymbolNode[] };
	"workspace.symbolEdgesTo": { symbols: readonly SymbolNode[] };
	"workspace.hasWarmIndex": { warm: boolean };
	"workspace.cacheStatus": WorkspaceCacheStatus;
	"workspace.referenceBasedRename": ReferenceBasedRenameOutcome;
	"workspace.prepareRename": Provenanced<{ range: RenameRange | null }>;
	"workspace.rename": Provenanced<{ touchedPaths: readonly string[] }>;
	"workspace.gitStatus": GitStatusSummary;
	"workspace.gitLog": { entries: readonly GitLogEntry[] };
	"workspace.gitDiff": GitDiffResult;
	"workspace.compareSymbolAcrossVersions": {
		readonly path: string;
		readonly symbolName: string;
		readonly fromRef: string;
		/** Echoes the literal string "working tree" when toRef was omitted from the request. */
		readonly toRef: string;
		readonly status: SymbolComparisonStatus;
		readonly diff: string;
		readonly truncated: boolean;
	};
	"repo.fetch": RepoFetchResult & { workspaceId: WorkspaceId };
	"repo.listCache": CachedRepositoryPage;
	"repo.evictCache": { evicted: boolean };
	"package.resolveSource": PackageSourceOperationResult;
	"package.listSources": { entries: readonly PackageSourceListEntry[]; nextCursor: string | null };
	"package.removeSource": { removed: boolean };
	"package.cleanSources": { removed: number; skipped: number };
	"search.githubRepos": GithubRepoSearchResult;
	"search.npmPackages": { candidates: readonly NpmPackageCandidate[] };
	"search.sourcegraphCode": { candidates: readonly SourcegraphCodeCandidate[] };
	"workspace.searchText": TextSearchResult;
	"workspace.findFiles": FindFilesResult;
	"workspace.watch": { watchId: string; topic: string };
	"workspace.unwatch": { unwatched: boolean };
	"search.symbols": { results: readonly WorkspaceQueryOutcome<SymbolSearchResult>[] };
	"search.text": { results: readonly WorkspaceQueryOutcome<TextSearchResult>[] };
	"job.submit": { job: JobSnapshot<PopulateSymbolGraphResult> };
	"job.status": { job: JobSnapshot<PopulateSymbolGraphResult> };
	"job.watch": { watchId: JobWatchId; topic: JobTopic };
	"workspace.createAnnotation": { annotation: SymbolAnnotation };
	"workspace.getAnnotation": { annotation: SymbolAnnotation | undefined };
	"workspace.listAnnotations": { annotations: readonly SymbolAnnotation[] };
	"workspace.refreshAnnotation": { annotation: SymbolAnnotation | undefined };
	"workspace.scrubAnnotation": { scrubbed: boolean };
	"workspace.restoreAnnotation": { restored: boolean };
	"workspace.containAnnotation": { contained: boolean };
	"workspace.uncontainAnnotation": { uncontained: boolean };
	"workspace.annotationTree": { annotations: readonly SymbolAnnotation[] };
	"workspace.map": WorkspaceMapResult;
}

/**
 * Deterministically derive a workspaceId from a resolved absolute path, so the same
 * directory always yields the same id -- across repeat calls AND across a daemon
 * restart, since nothing about this derivation depends on runtime/in-memory state.
 * A shorter digest than ContentHash's is deliberate: this identifies a workspace root
 * for addressing/logging, not a content value needing full collision resistance.
 */
export function deriveWorkspaceId(absolutePath: string): WorkspaceId {
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

export interface RegisteredWorkspace {
	readonly port: WorkspacePort;
	/** Present only for workspaces registered via workspace.registerPath -- required for symbol queries. */
	readonly rootPath?: string;
	/** Local work always outranks disposable fetched-repo work in the bounded job queue. */
	readonly origin: "local" | "remote";
	/** Present only for a workspace registered via repo.fetch -- the reference to re-check/refetch when its remote moves. */
	readonly remoteReference?: RepoReference;
}

export type MutableRegistry = Map<WorkspaceId, RegisteredWorkspace>;

export interface LectorServiceOptions {
	/** Threaded into the default LspSymbolIndex's open-file lifecycle and every workspace.populateSymbolGraph run. Defaults to a no-op. */
	logger?: Logger;
	/** Factory for the symbol index backing workspace.findSymbols and code intelligence, given the descriptor resolved for the call. Defaults to an LspSymbolIndex configured for whichever descriptor is passed. */
	createSymbolIndex?: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
	/** Shared managed installer for provisionable system-binary language servers. Never used by filesystem-only operations. */
	languageServerProvisioner?: LanguageServerProvisionerPort;
	/**
	 * Explicit opt-in to start with zero registered workspaces, relying entirely on
	 * workspace.registerPath at runtime -- the shape a long-lived background daemon that
	 * attaches to whatever project a host adapter (pi-lector) is used from actually needs.
	 * workspace.registerPath itself now rejects a non-absolute path outright (RelativeWorkspacePath)
	 * rather than resolving it against this process's own irrelevant cwd -- no implicit fallback
	 * reappears just because the registry started empty. Without this option, zero workspaces at
	 * construction is still refused (Locus LCS-BUG-88 class): the default stays "fail loud on
	 * likely misconfiguration," and a caller must say what it actually intends rather than the
	 * guard being silently loosened for everyone.
	 */
	allowDynamicOnly?: boolean;
	/** Factory for the graph backing workspace.populateSymbolGraph/reachableFrom/symbolEdgesFrom/symbolEdgesTo. Defaults to an in-memory graph (not durable across a restart). */
	createSymbolGraph?: (workspaceId: WorkspaceId) => SymbolGraphPort;
	/** Factory for the store backing workspace.createAnnotation/getAnnotation/listAnnotations/refreshAnnotation/scrubAnnotation/restoreAnnotation. Defaults to an in-memory store (not durable across a restart). */
	createSymbolAnnotations?: (workspaceId: WorkspaceId) => SymbolAnnotationPort;
	/** Factory for the store backing workspace.mutationHistory/revertMutation. Defaults to an in-memory store (not durable across a restart), bounded to 50 entries per file. */
	createMutationHistory?: (workspaceId: WorkspaceId) => MutationHistoryPort;
	/** Factory for the git port backing workspace.gitStatus/gitLog/gitDiff. Defaults to LocalGit, the real `git` CLI. Cheap to construct -- never cached, unlike symbol indexes. */
	createGitPort?: (rootPath: string) => GitPort;
	/** Factory for the port backing repo.fetch. No default -- unlike createSymbolGraph's safe in-memory fallback, fetching a real external repo always needs a real disk location only a host (daemon.ts) can supply. Called once at construction and reused, not per-call. */
	createRepoFetcher?: () => RepoFetcherPort;
	/** Override package-source resolution. With a repo fetcher configured, the default composes npm lockfiles, registry metadata, and exact Git fetching. */
	createPackageSourceResolver?: () => PackageSourceResolverPort;
	/** Factory for the bookkeeping index backing package.listSources/removeSource/cleanSources -- distinct from RepoFetcherPort's own disk cache, which has no notion of package identity. Defaults to an in-memory store (not durable across a restart), matching every other Lector store's own in-memory-first precedent. Called once at construction and reused. */
	createPackageSourceIndex?: () => PackageSourceIndexPort;
	/** Factory for the npm registry client backing both package.resolveSource's version lookups and search.npmPackages. Defaults to a real NpmRegistryClient. Called once at construction and reused -- tests inject a fixture-server-pointed instance instead of hitting the real registry. */
	createNpmRegistry?: () => NpmRegistryPort;
	/** Factory for the port backing search.githubRepos. Defaults to a real GithubSearchClient (GITHUB_TOKEN if configured, else GitHub's tighter unauthenticated rate limit). Called once at construction and reused. */
	createGithubSearch?: () => GithubSearchPort;
	/** Factory for the port backing search.sourcegraphCode. Defaults to a real SourcegraphSearchClient against public sourcegraph.com. Called once at construction and reused. */
	createSourcegraphSearch?: () => SourcegraphSearchPort;
	/** Factory for each external-search source's own short-TTL result cache. Defaults to a fresh InMemoryExternalSearchCache per source (github/npm/sourcegraph each get their own instance, never shared -- their result shapes differ). */
	createExternalSearchCache?: <T extends object>() => ExternalSearchCachePort<T>;
	/** Factory for the port backing workspace.searchText. Defaults to RipgrepTextSearch -- cheap to construct, no disk dependency, safe like createGitPort's default. Called once at construction and reused. */
	createTextSearch?: () => TextSearchPort;
	/** Factory for the port backing workspace.watch's real OS-level watching. Defaults to NodeFsFileWatcher. Called once per workspace, lazily, on its first active watch -- never for a workspace nobody has asked to watch. */
	createFileWatcher?: () => FileWatcherPort;
	/** Publishes a real file-change event to workspace.watch's own PushChannel topic. Defaults to a no-op -- a host without a real push transport (most embedders, most tests) still gets correct watch registration/matching, just no actual delivery. Wired to a real PushChannel.publish by daemon.ts. */
	publish?: (topic: string, payload: unknown) => void;
	/** Factory for workspace.searchText's result cache. Defaults to an in-memory-only InMemorySearchCache -- safe, no disk dependency. A host wanting the disk-backed tier too (surviving a restart) supplies a TieredSearchCache here. Called once at construction and reused. */
	createSearchCache?: () => SearchCachePort;
	/**
	 * The one hash-addressed content registry shared by rawRead/exactEdit, the default
	 * LspSymbolIndex, and TreeSitterSymbolIndex -- the same physical file read or written by any
	 * of them warms one entry the others reuse, instead of each independently reading/caching (or
	 * not caching at all) its own private view of the same bytes. A caller-supplied
	 * createSymbolIndex factory does not automatically receive this instance -- it owns its own
	 * construction. Defaults to a process-wide in-memory cache.
	 */
	createContentCache?: () => ContentCachePort;
	/** Process-lifetime background executor. Tests inject deterministic ids and tighter bounds. */
	createJobExecutor?: () => BoundedJobExecutor<PopulateSymbolGraphResult>;
	/** Debounce window before a real file change under a graph-watched workspace triggers an automatic re-population. Default 1000ms; tests use a much smaller value for speed. */
	graphRefreshDebounceMs?: number;
}

export function resolveWorkspace(registry: MutableRegistry, workspaceId: WorkspaceId): WorkspacePort {
	const entry = registry.get(workspaceId);
	if (!entry) throw new UnknownWorkspace(workspaceId);
	return entry.port;
}

/** True when a WorkspacePort also implements FileTreePort -- mirrors supportsCodeIntelligence's own duck-typed capability check below. */
function supportsFileTree(port: WorkspacePort): port is WorkspacePort & FileTreePort {
	return "listDirectory" in port && typeof port.listDirectory === "function";
}

/** Raised when a workspace's own WorkspacePort implementation does not also implement FileTreePort (e.g. a read-only fetched-repo checkout). */
export class WorkspaceDoesNotSupportFileTree extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" does not support directory-tree operations`);
		this.name = "WorkspaceDoesNotSupportFileTree";
	}
}

export function resolveFileTree(registry: MutableRegistry, workspaceId: WorkspaceId): FileTreePort {
	const port = resolveWorkspace(registry, workspaceId);
	if (!supportsFileTree(port)) throw new WorkspaceDoesNotSupportFileTree(workspaceId);
	return port;
}

type OperationHandlers = {
	[Name in OperationName]: (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
};

async function registerPath(registry: MutableRegistry, input: OperationInputs["workspace.registerPath"]): Promise<OperationOutputs["workspace.registerPath"]> {
	// Rejected outright, not resolved -- a daemon has no caller-relative "current directory" of
	// its own; resolve() on a relative path would silently use this PROCESS's own cwd (e.g. a
	// systemd unit's fixed WorkingDirectory), not whatever the real caller actually meant.
	assertAbsolutePath(input.path);
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
export const MAX_INITIAL_JOB_WAIT_MS = 30_000;
export const MAX_SYMBOL_RESULTS = 5_000;
export const MAX_SOURCE_MANIFEST_BYTES = 50 * 1024 * 1024;
/** Files populateSymbolGraph dispatches to the LSP concurrently -- cost is round-trip latency, not CPU (see populate-symbol-graph-concurrency.perf.test.ts). Well under LspSymbolIndex's default 256 open-file cap. */
export const POPULATION_CONCURRENCY = 8;
/**
 * Bound for the allNodes/allEdges reads used to find files referencing a changed file's
 * declarations, when deciding what a repopulate can safely skip. If the graph is at or beyond
 * this size, the read may be truncated and could miss a real dependent -- fails closed by
 * reprocessing every file instead, never by risking a silently dropped cross-file edge.
 */
export const MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP = 200_000;
const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

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
	const logger = options.logger ?? NOOP_LOGGER;
	let nextJobId = 0;
	const jobs =
		options.createJobExecutor?.() ??
		new BoundedJobExecutor<PopulateSymbolGraphResult>({
			maxConcurrent: 2,
			maxQueued: 32,
			maxRetained: 128,
			retentionMs: 10 * 60 * 1000,
			createId: () => `job-${Date.now().toString(36)}-${(++nextJobId).toString(36)}`,
			logger,
		});

	// The one hash-addressed content registry shared by rawRead/exactEdit and the DEFAULT
	// LspSymbolIndex/TreeSitterSymbolIndex construction below -- process-wide, not per-workspace,
	// matching ContentCachePort's own content-addressed design (identical bytes share one entry
	// regardless of which file or workspace they came from). A caller-supplied createSymbolIndex
	// owns its own construction and does not automatically receive this instance.
	const contentCache = options.createContentCache?.() ?? new InMemoryContentCache();

	const createSymbolIndex =
		options.createSymbolIndex ??
		((rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => {
			const semantic = new LspSymbolIndex(rootPath, descriptor, seedFile, { contentCache, logger, provisioner: options.languageServerProvisioner });
			if (descriptor.languageId !== "typescript") return semantic;
			return new FallbackCodeIntelligenceIndex(semantic, [new TypeScriptCompilerSymbolIndex(rootPath), new TreeSitterSymbolIndex(rootPath, contentCache)]);
		});
	const warmIndexes = new WarmIndexRegistry<WorkspaceId>({
		descriptors: LANGUAGE_SERVER_DESCRIPTORS,
		createIndex: createSymbolIndex,
		resolveRoot: (workspaceId) => {
			const entry = registry.get(workspaceId);
			if (!entry) throw new UnknownWorkspace(workspaceId);
			if (!entry.rootPath) throw new SymbolQueryUnavailable(workspaceId);
			return entry.rootPath;
		},
		unsupportedLanguage: (path) => new UnsupportedLanguage(path),
	});

	const graphRefresh = new GraphRefreshCoordinator<WorkspaceId, string>({
		createGraph: options.createSymbolGraph ?? (() => new InMemorySymbolGraph()),
		debounceMs: options.graphRefreshDebounceMs ?? 1000,
		logger,
	});
	const ensureSymbolGraph = (workspaceId: WorkspaceId): SymbolGraphPort => graphRefresh.graph(workspaceId);

	const annotationHandlers = new AnnotationHandlers({ registry, graph: ensureSymbolGraph, createStore: options.createSymbolAnnotations });
	const mutationHistory = new MutationHistoryCoordinator({ registry, createStore: options.createMutationHistory, fileOperations: warmIndexes });

	const createGitPort = options.createGitPort ?? ((rootPath: string) => new LocalGit(rootPath));
	// Constructed once, not per-call -- reconstructing would rehydrate the same on-disk index
	// every time, wastefully, and would risk losing the in-memory LRU's recency ordering
	// between calls for no benefit (the index itself is what makes rehydration correct at all).
	const repoFetcher = options.createRepoFetcher?.();
	const npmRegistry = options.createNpmRegistry?.() ?? new NpmRegistryClient();
	const packageSourceResolver =
		options.createPackageSourceResolver?.() ??
		(repoFetcher ? new NpmPackageSourceResolver({ versions: new NpmLockfileVersionResolver(), registry: npmRegistry, repositories: repoFetcher }) : undefined);
	const packageSourceIndex = options.createPackageSourceIndex?.() ?? new InMemoryPackageSourceIndex();
	const githubSearch = options.createGithubSearch?.() ?? new GithubSearchClient();
	const sourcegraphSearch = options.createSourcegraphSearch?.() ?? new SourcegraphSearchClient();
	const createExternalSearchCache = options.createExternalSearchCache ?? (<T extends object>() => new InMemoryExternalSearchCache<T>());
	const githubSearchCache = createExternalSearchCache<GithubRepoSearchResult>();
	const npmSearchCache = createExternalSearchCache<{ candidates: readonly NpmPackageCandidate[] }>();
	const sourcegraphSearchCache = createExternalSearchCache<{ candidates: readonly SourcegraphCodeCandidate[] }>();
	const textSearch = options.createTextSearch?.() ?? new RipgrepTextSearch();
	const searchCache = options.createSearchCache?.() ?? new InMemorySearchCache();
	const createFileWatcher = options.createFileWatcher ?? (() => new NodeFsFileWatcher());
	const publish = options.publish ?? (() => {});
	/** Serializes workspace.rename's atomic multi-file apply per workspace root -- a concurrent second rename (or reference-based rename) for the same workspace waits its turn rather than interleaving mid-apply. */
	const renameMutationBarrier = new SerialExecutionQueue();

	// symbolGraphHandlers and workspaceWatchHandlers are mutually dependent: populateSymbolGraph
	// needs to arm the OS watcher once a workspace is first populated, and the watcher needs to
	// trigger a fresh population on a later file change. Broken with a late-bound indirection --
	// symbolGraphHandlers gets a callback that starts as a no-op and is rebound to the real
	// ensureOsWatcher once workspaceWatchHandlers exists (both constructions below are
	// synchronous, so the rebind always lands before any real call could occur).
	let ensureOsWatcher: (workspaceId: WorkspaceId, rootPath: string) => void = () => {};
	const symbolGraphHandlers = createSymbolGraphHandlers({
		registry,
		warmIndexes,
		graphRefresh,
		repoFetcher,
		createGitPort,
		jobs,
		logger,
		renameMutationBarrier,
		publish,
		ensureOsWatcher: (workspaceId, rootPath) => ensureOsWatcher(workspaceId, rootPath),
	});
	const workspaceWatchHandlers = new WorkspaceWatchHandlers({
		registry,
		createWatcher: createFileWatcher,
		publish,
		notifyWarmIndexes: (workspaceId, event) => warmIndexes.notifyFileChanged(workspaceId, event),
		isGraphWatched: (workspaceId) => graphRefresh.isWatched(workspaceId),
		scheduleGraphRefresh: (workspaceId) => {
			graphRefresh.schedule(workspaceId, () => {
				void symbolGraphHandlers.scheduleGraphRefresh(workspaceId);
			});
		},
	});
	ensureOsWatcher = (workspaceId, rootPath) => workspaceWatchHandlers.ensureOsWatcher(workspaceId, rootPath);
	const gitHandlers = createGitHandlers({ registry, createGitPort, logger });
	const repoFetchHandlers = createRepoFetchHandlers({ repoFetcher, logger });
	const packageSourceHandlers = createPackageSourceHandlers({ packageSourceResolver, packageSourceIndex, repoFetcher, logger });
	const externalSearchHandlers = createExternalSearchHandlers({
		githubSearch,
		npmRegistry,
		sourcegraphSearch,
		githubSearchCache,
		npmSearchCache,
		sourcegraphSearchCache,
	});
	const codeIntelligenceHandlers = createCodeIntelligenceHandlers({ warmIndexes });
	const workspaceFileHandlers = createWorkspaceFileHandlers({ contentCache, mutationHistory, warmIndexes, textSearch, searchCache });
	const crossWorkspaceHandlers = createCrossWorkspaceHandlers({
		registry,
		findSymbols: (input) => codeIntelligenceHandlers["workspace.findSymbols"](registry, input),
		searchText: (input) => workspaceFileHandlers["workspace.searchText"](registry, input),
	});

	const workspaceMapHandler = createWorkspaceMapHandler(ensureSymbolGraph);

	const handlers: OperationHandlers = {
		...workspaceFileHandlers,
		"workspace.registerPath": registerPath,
		...codeIntelligenceHandlers,
		...symbolGraphHandlers.handlers,
		...gitHandlers,
		...repoFetchHandlers,
		...packageSourceHandlers,
		...mutationHistory.handlers,
		...annotationHandlers.handlers,
		...externalSearchHandlers,
		...crossWorkspaceHandlers,
		...workspaceWatchHandlers.handlers,
		"workspace.map": workspaceMapHandler,
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
			workspaceWatchHandlers.close();
			await Promise.all([warmIndexes.closeAll(), graphRefresh.close(), annotationHandlers.close()]);
		},
		async reapIdleSymbolIndexes(maxIdleMs: number): Promise<number> {
			return warmIndexes.reapIdle(maxIdleMs);
		},
	};
}

export { JobCapacityExceeded, JobNotFound } from "./concurrency/bounded-job-executor.ts";
export type { ClosableSymbolIndex } from "./service/warm-index-registry.ts";
export { LineEditRace, LineEditRejected, PatchRejected, RelativeWorkspacePath, StaleExpectedHash, WatchLimitExceeded, WorkspaceEntryNotFound };
