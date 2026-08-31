import type { CodeActionPreview, CodeActionPreviewId } from "../code-intelligence/code-action.ts";
import type { SymbolComparisonStatus } from "../code-intelligence/compare-symbol-declarations.ts";
import type { Diagnostic } from "../code-intelligence/diagnostic.ts";
import type { DocumentHighlight } from "../code-intelligence/document-highlight.ts";
import type { DocumentSymbolEntry } from "../code-intelligence/document-symbol.ts";
import type { Hover } from "../code-intelligence/hover.ts";
import type { ImpactAnalysisResult } from "../code-intelligence/impact-analysis.ts";
import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { DataFlowHint } from "../code-intelligence/tree-sitter/data-flow-hints.ts";
import type { TypeHierarchyEntry } from "../code-intelligence/type-hierarchy.ts";
import type { NarrowedType } from "../code-intelligence/typescript-narrowed-type.ts";
import type { JobSnapshot } from "../concurrency/bounded-job-executor.ts";
import type { ContentHash } from "../content-identity/content-hash.ts";
import type { GithubRepoSearchResult, NpmPackageCandidate, SourcegraphCodeCandidate } from "../external-search/external-search-result.ts";
import type { GitDiffResult } from "../git/diff-result.ts";
import type { GitGrepResult } from "../git/grep-result.ts";
import type { GitHistoryGrepResult } from "../git/history-grep-result.ts";
import type { GitListFilesResult } from "../git/list-files-result.ts";
import type { GitLogEntry } from "../git/log-entry.ts";
import type { GitStatusSummary } from "../git/status.ts";
import type { BoundedMutationHistoryEntry } from "../mutation-history/bound-mutation-history-entries.ts";
import type { PackageEcosystem, PackageSourceBounds, PackageSourceOperationResult, PackageSourceRequest } from "../package-source/package-source.ts";
import type { PackageSourceIndexQuery, PackageSourceListEntry } from "../package-source/package-source-index.ts";
import type { ReferenceBasedRenameOutcome } from "../reference-based-rename/apply-reference-based-rename.ts";
import type { CachedRepositoryPage, CachedRepositoryQuery } from "../repo-fetcher/cached-repository-entry.ts";
import type { RepoFetchResult } from "../repo-fetcher/repo-fetch-result.ts";
import type { RepoReference } from "../repo-fetcher/repo-reference.ts";
import type { AnnotationId, SymbolAnnotation } from "../symbol-annotation/symbol-annotation.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../symbol-graph/call-hierarchy.ts";
import type { PopulateSymbolGraphResult, SymbolGraphPopulationFailure } from "../symbol-graph/populate-symbol-graph.ts";
import type { SymbolEdgeKind, SymbolNode } from "../symbol-graph/port.ts";
import type { WorkspaceCacheStatus } from "../symbol-graph/symbol-graph-generation.ts";
import type { FindFilesResult } from "../text-search/find-files-result.ts";
import type { TextSearchResult } from "../text-search/text-search-result.ts";
import type { EditOutcome, ExpectedHashEdit } from "../workspace/exact-edit.ts";
import type { LineEdit, LineEditOutcome } from "../workspace/line-edit.ts";
import type { DirectoryListing } from "../workspace/list-directory.ts";
import type { ContextBundleResult } from "../workspace/localize-context.ts";
import type { RawRead } from "../workspace/raw-read.ts";
import type { WorkspaceResolutionRequest } from "../workspace/resolve-workspace-path.ts";
import type { ResponseFormat } from "../workspace/response-format.ts";
import type { RenameRange } from "../workspace/workspace-edit.ts";
import type { WorkspaceMapResult } from "../workspace/workspace-map.ts";
import type { WorkspaceQueryOutcome } from "../workspace/workspace-query-outcome.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { DiagnosticValidationResult, GitDiagnosticValidationResult } from "./diagnostic-validation-coordinator.ts";
import type { JobTopic, JobWatchId, WorkspaceId } from "./errors.ts";
import type { ActiveCachingJobSummary } from "./symbol-graph/cache-query-handlers.ts";

export type OperationName =
	| "workspace.rawRead"
	| "workspace.exactEdit"
	| "workspace.deleteEntry"
	| "workspace.lineEdit"
	| "workspace.applyPatch"
	| "workspace.mutationHistory"
	| "workspace.revertMutation"
	| "workspace.mutationTransaction"
	| "workspace.revertMutationTransaction"
	| "workspace.registerPath"
	| "workspace.resolvePath"
	| "workspace.release"
	| "workspace.findSymbols"
	| "workspace.goToDefinition"
	| "workspace.goToImplementation"
	| "workspace.findReferences"
	| "workspace.documentHighlights"
	| "workspace.dataFlowHints"
	| "workspace.narrowedType"
	| "workspace.hover"
	| "workspace.documentSymbols"
	| "workspace.diagnostics"
	| "workspace.prepareCallHierarchy"
	| "workspace.incomingCalls"
	| "workspace.outgoingCalls"
	| "workspace.prepareTypeHierarchy"
	| "workspace.supertypes"
	| "workspace.subtypes"
	| "workspace.impactAnalysis"
	| "workspace.diagnosticDelta"
	| "workspace.previewCodeActions"
	| "workspace.applyCodeAction"
	| "workspace.populateSymbolGraph"
	| "workspace.reachableFrom"
	| "workspace.symbolEdgesFrom"
	| "workspace.symbolEdgesTo"
	| "workspace.hasWarmIndex"
	| "workspace.cacheStatus"
	| "workspace.cacheWalkedFiles"
	| "workspace.cacheFailures"
	| "workspace.activeCachingJobs"
	| "workspace.referenceBasedRename"
	| "workspace.prepareRename"
	| "workspace.rename"
	| "workspace.gitStatus"
	| "workspace.gitLog"
	| "workspace.gitDiff"
	| "workspace.gitShowFile"
	| "workspace.gitGrep"
	| "workspace.gitGrepHistory"
	| "workspace.gitListFiles"
	| "workspace.gitIsAncestor"
	| "workspace.gitWorktreeAdd"
	| "workspace.gitWorktreeRemove"
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
	| "workspace.localizeContext"
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
	"workspace.mutationTransaction",
	"workspace.revertMutationTransaction",
	"workspace.registerPath",
	"workspace.resolvePath",
	"workspace.release",
	"workspace.findSymbols",
	"workspace.goToDefinition",
	"workspace.goToImplementation",
	"workspace.findReferences",
	"workspace.documentHighlights",
	"workspace.dataFlowHints",
	"workspace.narrowedType",
	"workspace.hover",
	"workspace.documentSymbols",
	"workspace.diagnostics",
	"workspace.prepareCallHierarchy",
	"workspace.incomingCalls",
	"workspace.outgoingCalls",
	"workspace.prepareTypeHierarchy",
	"workspace.supertypes",
	"workspace.subtypes",
	"workspace.impactAnalysis",
	"workspace.diagnosticDelta",
	"workspace.previewCodeActions",
	"workspace.applyCodeAction",
	"workspace.populateSymbolGraph",
	"workspace.reachableFrom",
	"workspace.symbolEdgesFrom",
	"workspace.symbolEdgesTo",
	"workspace.hasWarmIndex",
	"workspace.cacheStatus",
	"workspace.cacheWalkedFiles",
	"workspace.cacheFailures",
	"workspace.activeCachingJobs",
	"workspace.referenceBasedRename",
	"workspace.prepareRename",
	"workspace.rename",
	"workspace.gitStatus",
	"workspace.gitLog",
	"workspace.gitDiff",
	"workspace.gitShowFile",
	"workspace.gitGrep",
	"workspace.gitGrepHistory",
	"workspace.gitListFiles",
	"workspace.gitIsAncestor",
	"workspace.gitWorktreeAdd",
	"workspace.gitWorktreeRemove",
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
	"workspace.localizeContext",
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
	"workspace.mutationHistory": { workspaceId: WorkspaceId; path: string; maxResults: number; maxBytes?: number };
	"workspace.revertMutation": { workspaceId: WorkspaceId; entryId: string };
	"workspace.mutationTransaction": { workspaceId: WorkspaceId; transactionId: string };
	"workspace.revertMutationTransaction": { workspaceId: WorkspaceId; transactionId: string };
	"workspace.registerPath": { path: string };
	/**
	 * The single, canonical "which workspace does this path belong to" decision, shared by every
	 * caller that previously reimplemented its own walk-up-the-filesystem algorithm client-side
	 * (pi-lector's own former nearest-workspace-root.ts) -- see resolveWorkspacePath's own doc
	 * comment for the full strategy/fallback mapping. `path` may be a file or a directory for
	 * "path-or-directory" (the daemon checks); every other strategy treats it as the directory to
	 * start walking upward FROM (a caller holding a file path computes its own dirname() first --
	 * pure string parsing, not real domain logic worth a round trip to avoid).
	 */
	"workspace.resolvePath": WorkspaceResolutionRequest;
	"workspace.release": { workspaceId: WorkspaceId };
	"workspace.listDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.createDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.renamePath": { workspaceId: WorkspaceId; oldPath: string; newPath: string };
	"workspace.deleteDirectory": { workspaceId: WorkspaceId; path: string };
	"workspace.findSymbols": { workspaceId: WorkspaceId; query: string; seedFile?: string; maxResults?: number; responseFormat?: ResponseFormat };
	"workspace.goToDefinition": WorkspacePosition & { maxResults?: number; maxBytes?: number };
	"workspace.goToImplementation": WorkspacePosition & { maxResults?: number; maxBytes?: number };
	"workspace.findReferences": WorkspacePosition & { includeDeclaration: boolean; responseFormat?: ResponseFormat; maxResults?: number; maxBytes?: number };
	"workspace.documentHighlights": WorkspacePosition & { maxResults?: number; maxBytes?: number };
	"workspace.dataFlowHints": { workspaceId: WorkspaceId; path: string; maxResults?: number; maxBytes?: number };
	"workspace.narrowedType": WorkspacePosition & { maxBytes?: number };
	"workspace.hover": WorkspacePosition & { maxBytes?: number };
	"workspace.documentSymbols": { workspaceId: WorkspaceId; path: string; maxResults?: number; maxBytes?: number };
	"workspace.diagnostics": { workspaceId: WorkspaceId; path: string; maxResults?: number; maxBytes?: number };
	"workspace.prepareCallHierarchy": WorkspacePosition;
	"workspace.incomingCalls": WorkspacePosition & { maxResults?: number; maxBytes?: number };
	"workspace.outgoingCalls": WorkspacePosition & { maxResults?: number; maxBytes?: number };
	"workspace.prepareTypeHierarchy": WorkspacePosition & { maxResults?: number; maxBytes?: number; deadlineMs?: number };
	"workspace.supertypes": WorkspacePosition & { maxResults?: number; maxBytes?: number; deadlineMs?: number };
	"workspace.subtypes": WorkspacePosition & { maxResults?: number; maxBytes?: number; deadlineMs?: number };
	"workspace.diagnosticDelta": {
		workspaceId: WorkspaceId;
		source: { kind: "transaction"; transactionId: string } | { kind: "git"; ref: string };
		maxResults?: number;
		maxBytes?: number;
		maxDepth?: number;
		maxNodes?: number;
		maxEdges?: number;
		deadlineMs?: number;
		maxFiles?: number;
		maxSymbolsPerFile?: number;
		autoPopulate?: boolean;
	};
	"workspace.impactAnalysis": {
		workspaceId: WorkspaceId;
		source: { kind: "git"; ref?: string } | { kind: "mutation"; transactionId: string };
		maxDepth?: number;
		maxNodes?: number;
		maxEdges?: number;
		maxBytes?: number;
		deadlineMs?: number;
		coverage?: readonly { testPath: string; coveredPaths: readonly string[] }[];
		autoPopulate?: boolean;
		maxFiles: number;
		maxSymbolsPerFile: number;
	};
	/**
	 * allowBroadRoot is an explicit, auditable opt-in past classifyAutoPopulationRoot's own refusal
	 * -- see BroadNonProjectRoot. retryTimeBudgetMs, when given, retries a WorkspaceChangedDuringPopulation
	 * race (a file changed mid-population) within this many milliseconds of wall-clock time before
	 * giving up and throwing that same error -- omitted/0 (the default) preserves today's exact
	 * fail-fast behavior.
	 */
	"workspace.populateSymbolGraph": {
		workspaceId: WorkspaceId;
		maxFiles: number;
		maxSymbolsPerFile: number;
		allowBroadRoot?: boolean;
		retryTimeBudgetMs?: number;
	};
	"workspace.reachableFrom": WorkspacePosition & {
		maxDepth: number;
		kind?: SymbolEdgeKind;
		maxResults?: number;
		maxBytes?: number;
		/**
		 * When true and the graph has no completed generation at all for maxFiles/maxSymbolsPerFile
		 * (never "partial"), populates once at those exact bounds before querying, instead of
		 * silently returning an empty result for a position the graph never scanned. Requires
		 * maxFiles/maxSymbolsPerFile when set. Opt-in and false by default -- see
		 * workspace.referenceBasedRename's own autoPopulate doc comment for why this workspace is not
		 * always a caller's correct final scope to auto-populate.
		 */
		autoPopulate?: boolean;
		maxFiles?: number;
		maxSymbolsPerFile?: number;
	};
	"workspace.symbolEdgesFrom": WorkspacePosition & { kind?: SymbolEdgeKind; maxResults?: number; maxBytes?: number };
	"workspace.symbolEdgesTo": WorkspacePosition & { kind?: SymbolEdgeKind; maxResults?: number; maxBytes?: number };
	"workspace.hasWarmIndex": { workspaceId: WorkspaceId; path?: string };
	"workspace.cacheStatus": { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number };
	/** Enumerates active population jobs globally when ownerId is omitted, or only jobs requested by that explicit caller owner. */
	"workspace.activeCachingJobs": { ownerId?: string };
	/** Paginated raw detail behind cacheStatus's own compact summary -- the workspace's last completed generation regardless of whether it is still fresh (this is inspection, not a freshness check). Throws NoCompletedGeneration if none exists yet. */
	"workspace.cacheWalkedFiles": { workspaceId: WorkspaceId; offset: number; maxResults: number; maxBytes: number };
	/** Paginated raw (non-deduplicated) failures behind cacheStatus's own compact failureSummary -- see workspace.cacheWalkedFiles for the same completed-generation semantics. */
	"workspace.cacheFailures": { workspaceId: WorkspaceId; offset: number; maxResults: number; maxBytes: number };
	/**
	 * maxFiles/maxSymbolsPerFile gate the same freshness check cacheStatus uses -- this rename
	 * refuses outright unless the graph is fully "cached" (never "partial") for those exact bounds.
	 * autoPopulate, when true, recovers automatically from a "not-cached" graph (populating once at
	 * these exact bounds, then re-checking) instead of refusing -- opt-in and false by default,
	 * since this workspace is not always the correct final scope for a caller with its own wider-
	 * scope fallback logic (e.g. pi-lector's own widen-to-declared-monorepo-root retry): auto-
	 * populating the wrong, too-narrow scope could make a rename "succeed" while silently missing a
	 * real cross-package reference the wider scope would have caught -- worse than refusing. Never
	 * recovers from "partial" (a real per-file failure, not merely absent data) or "caching"/
	 * "waiting-for-resources" (another population already in flight) regardless of this flag.
	 */
	"workspace.referenceBasedRename": {
		workspaceId: WorkspaceId;
		fromPath: string;
		toPath: string;
		maxFiles: number;
		maxSymbolsPerFile: number;
		autoPopulate?: boolean;
	};
	"workspace.prepareRename": WorkspacePosition;
	"workspace.rename": WorkspacePosition & { newName: string };
	"workspace.previewCodeActions": {
		workspaceId: WorkspaceId;
		path: string;
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
		diagnostics?: readonly Diagnostic[];
		only?: readonly string[];
		includeCommandActions?: boolean;
		maxActions: number;
		maxEdits: number;
		maxFiles: number;
		maxBytes: number;
		deadlineMs: number;
	};
	"workspace.applyCodeAction": { workspaceId: WorkspaceId; previewId: CodeActionPreviewId };
	"workspace.gitStatus": { workspaceId: WorkspaceId };
	"workspace.gitLog": { workspaceId: WorkspaceId; maxCount: number };
	"workspace.gitDiff": { workspaceId: WorkspaceId; ref?: string; maxBytes: number };
	/** A path's exact blob content at `ref`, exposed as its own real-time-verification operation (Tier 1) rather than only compareSymbolAcrossVersions' own internal use of the identical GitPort call. */
	"workspace.gitShowFile": { workspaceId: WorkspaceId; ref: string; path: string };
	/** Text search across `ref`'s own tree, no checkout -- the ref-scoped equivalent of workspace.searchText. pathspecs narrows the search (grep's own glob-based pathspec matching). */
	"workspace.gitGrep": { workspaceId: WorkspaceId; ref: string; pattern: string; pathspecs?: readonly string[]; maxMatches: number; maxBytes: number };
	/** Bounded regex search across commit trees reachable from all refs, with deterministic topological paging and exact path/line/text deduplication. */
	"workspace.gitGrepHistory": {
		workspaceId: WorkspaceId;
		pattern: string;
		pathspecs?: readonly string[];
		commitOffset: number;
		maxCommits: number;
		maxMatches: number;
		maxBytes: number;
		deadlineMs: number;
	};
	/** Every file path in `ref`'s own tree, no checkout. pathspecs narrows the listing (ls-tree's own prefix-based pathspec matching, not glob-based like gitGrep's). */
	"workspace.gitListFiles": { workspaceId: WorkspaceId; ref: string; pathspecs?: readonly string[]; maxResults: number };
	/** True iff ancestorRef is a real ancestor of (or the exact same commit as) ref -- the backport/reachability check a "was this fix ported to release-X" question actually needs. */
	"workspace.gitIsAncestor": { workspaceId: WorkspaceId; ancestorRef: string; ref: string };
	/** forceRefresh recreates an already-reused worktree at ref's current tip instead of returning the existing one. */
	"workspace.gitWorktreeAdd": { workspaceId: WorkspaceId; ref: string; forceRefresh?: boolean };
	"workspace.gitWorktreeRemove": { workspaceId: WorkspaceId };
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
	/** maxResults, when given, is applied per workspace (the same way a direct workspace.findSymbols call would apply it) -- a caller asking for at most 10 results is asking that of each workspace searched, not 10 total across every one of them. */
	"search.symbols": { query: string; workspaceIds?: readonly WorkspaceId[]; timeoutMs?: number; maxResults?: number };
	"search.text": { query: string; maxMatches: number; maxBytes: number; workspaceIds?: readonly WorkspaceId[]; timeoutMs?: number };
	"job.submit": {
		operation: "workspace.populateSymbolGraph";
		/** Opaque caller identity used only to scope best-effort job presentation; not an authorization boundary. */
		ownerId?: string;
		/** retryTimeBudgetMs: see workspace.populateSymbolGraph's own doc comment -- same opt-in retry-on-race semantics, threaded through unchanged. */
		input: { workspaceId: WorkspaceId; maxFiles: number; maxSymbolsPerFile: number; retryTimeBudgetMs?: number };
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
		/**
		 * When true and the graph has no completed generation at all for maxFiles/maxSymbolsPerFile
		 * (never "partial" -- a real per-file failure, not merely absent data), populates once at those
		 * exact bounds before resolving anchors, instead of failing UnknownAnnotationAnchor outright.
		 * Requires maxFiles/maxSymbolsPerFile when set. Opt-in and false by default: an anchor that
		 * still can't resolve after populating is a real absence, not something to retry further.
		 */
		autoPopulate?: boolean;
		maxFiles?: number;
		maxSymbolsPerFile?: number;
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
		/** See workspace.createAnnotation; refresh uses the same bounded anchor-recovery semantics. */
		autoPopulate?: boolean;
		maxFiles?: number;
		maxSymbolsPerFile?: number;
	};
	"workspace.scrubAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.restoreAnnotation": { workspaceId: WorkspaceId; id: AnnotationId };
	"workspace.containAnnotation": { workspaceId: WorkspaceId; parentId: AnnotationId; childId: AnnotationId };
	"workspace.uncontainAnnotation": { workspaceId: WorkspaceId; parentId: AnnotationId; childId: AnnotationId };
	"workspace.annotationTree": { workspaceId: WorkspaceId; rootId: AnnotationId; maxDepth: number };
	"workspace.map": { workspaceId: WorkspaceId; maxNodes: number; maxEdges: number; maxEntries: number; maxBytes: number };
	"workspace.localizeContext": {
		workspaceId: WorkspaceId;
		query: string;
		seedSymbols?: readonly string[];
		seedLocations?: readonly { path: string; line: number; character?: number }[];
		maxSymbols?: number;
		maxBytes?: number;
		maxDepth?: number;
		deadlineMs?: number;
	};
}

type Provenanced<T> = T & { readonly provenance: IntelligenceProvenance };

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
	"workspace.deleteEntry": { path: string; previousHash: ContentHash | null };
	"workspace.lineEdit": LineEditOutcome;
	"workspace.applyPatch": EditOutcome;
	"workspace.mutationHistory": { entries: readonly BoundedMutationHistoryEntry[]; truncated: boolean };
	/** newHash is null when the reverted-to state is "the file doesn't exist" -- reverting a create back to nonexistence, or reverting a delete when the file has stayed deleted since. */
	"workspace.revertMutation": { path: string; newHash: ContentHash | null };
	"workspace.mutationTransaction": { transactionId: string; entries: readonly BoundedMutationHistoryEntry[]; truncated: boolean };
	/** transactionId here is the REVERT's own new transaction id (itself further-revertible), not the one that was reverted. */
	"workspace.revertMutationTransaction": { transactionId: string; reverted: readonly { path: string; newHash: ContentHash | null }[] };
	"workspace.registerPath": { workspaceId: WorkspaceId; created: boolean };
	/**
	 * found is false for "declared-monorepo-root" (the one strategy with no directory-itself/
	 * filesystem-root fallback) and for "code-intelligence-path-or-directory" given a genuinely
	 * nonexistent path (reason: "nonexistent-path") -- every other strategy/case always resolves
	 * to something.
	 */
	"workspace.resolvePath":
		| { readonly found: true; readonly workspaceId: WorkspaceId; readonly root: string; readonly created: boolean }
		| { readonly found: false; readonly reason?: "nonexistent-path" };
	/** closedIndexes/closedGraph/closedWatch each report only what this call itself actually tore down -- a workspace that was never warmed, populated, or watched legitimately reports zero/false across the board without that being an error. */
	"workspace.release": { workspaceId: WorkspaceId; closedIndexes: number; closedGraph: boolean; closedWatch: boolean };
	"workspace.listDirectory": DirectoryListing;
	"workspace.createDirectory": { path: string };
	"workspace.renamePath": { oldPath: string; newPath: string };
	"workspace.deleteDirectory": { path: string };
	"workspace.findSymbols": SymbolSearchResult;
	"workspace.goToDefinition": Provenanced<{ locations: readonly WorkspaceLocation[]; truncated: boolean }>;
	"workspace.goToImplementation": Provenanced<{ locations: readonly WorkspaceLocation[]; truncated: boolean }>;
	"workspace.findReferences": Provenanced<{ locations: readonly WorkspaceLocation[]; truncated: boolean }>;
	"workspace.documentHighlights": Provenanced<{ highlights: readonly DocumentHighlight[]; truncated: boolean }>;
	"workspace.dataFlowHints": { hints: readonly DataFlowHint[]; truncated: boolean };
	"workspace.narrowedType": { type: NarrowedType | undefined; truncated: boolean };
	/** truncated is true only when hover text itself was cut by maxBytes -- absent entirely (undefined hover) is not truncation. */
	"workspace.hover": Provenanced<{ hover: Hover | undefined; truncated: boolean }>;
	"workspace.documentSymbols": Provenanced<{ symbols: readonly DocumentSymbolEntry[]; truncated: boolean }>;
	"workspace.diagnostics": Provenanced<{ diagnostics: readonly Diagnostic[]; truncated: boolean }>;
	"workspace.prepareCallHierarchy": Provenanced<{ items: readonly CallHierarchyEntry[] }>;
	"workspace.incomingCalls": Provenanced<{ calls: readonly IncomingCall[]; truncated: boolean }>;
	"workspace.outgoingCalls": Provenanced<{ calls: readonly OutgoingCall[]; truncated: boolean }>;
	"workspace.prepareTypeHierarchy": Provenanced<{ items: readonly TypeHierarchyEntry[]; truncated: boolean }>;
	"workspace.supertypes": Provenanced<{ items: readonly TypeHierarchyEntry[]; truncated: boolean }>;
	"workspace.subtypes": Provenanced<{ items: readonly TypeHierarchyEntry[]; truncated: boolean }>;
	"workspace.impactAnalysis": ImpactAnalysisResult;
	"workspace.diagnosticDelta": (DiagnosticValidationResult | GitDiagnosticValidationResult) & { truncated: boolean };
	"workspace.populateSymbolGraph": PopulateSymbolGraphResult;
	"workspace.reachableFrom": { symbols: readonly SymbolNode[]; truncated: boolean };
	"workspace.symbolEdgesFrom": { symbols: readonly SymbolNode[]; truncated: boolean };
	"workspace.symbolEdgesTo": { symbols: readonly SymbolNode[]; truncated: boolean };
	"workspace.hasWarmIndex": { warm: boolean };
	"workspace.cacheStatus": WorkspaceCacheStatus;
	"workspace.activeCachingJobs": { jobs: readonly ActiveCachingJobSummary[] };
	"workspace.cacheWalkedFiles": { files: readonly string[]; totalCount: number; nextOffset: number; truncated: boolean };
	"workspace.cacheFailures": { failures: readonly SymbolGraphPopulationFailure[]; totalCount: number; nextOffset: number; truncated: boolean };
	/** steps carries full before/after file content internally for mutation-history recording -- deliberately excluded from the wire response, which stays the small movedTo/filesUpdated/caveats summary every caller already expects. */
	"workspace.referenceBasedRename": Omit<ReferenceBasedRenameOutcome, "steps"> & { transactionId: string };
	"workspace.prepareRename": Provenanced<{ range: RenameRange | null }>;
	"workspace.rename": Provenanced<{ touchedPaths: readonly string[]; transactionId?: string }>;
	"workspace.previewCodeActions": Provenanced<{ actions: readonly CodeActionPreview[]; truncated: boolean; deadlineReached: boolean }>;
	"workspace.applyCodeAction": Provenanced<{
		touchedPaths: readonly string[];
		transactionId?: string;
		/** Commands are previewed but remain outside the atomic file-edit transaction. */
		pendingCommand?: { readonly title: string; readonly command: string };
	}>;
	"workspace.gitStatus": GitStatusSummary;
	"workspace.gitLog": { entries: readonly GitLogEntry[] };
	"workspace.gitDiff": GitDiffResult;
	/** Undefined content means path did not exist at ref -- a real, expected case, never an error. */
	"workspace.gitShowFile": { content: string | undefined };
	"workspace.gitGrep": GitGrepResult;
	"workspace.gitGrepHistory": GitHistoryGrepResult;
	"workspace.gitListFiles": GitListFilesResult;
	"workspace.gitIsAncestor": { isAncestor: boolean };
	/**
	 * A brand-new read-only workspace (own workspaceId, distinct from the source repo's) backed by
	 * a real detached git worktree checked out to `ref` -- every other Lector operation
	 * (findSymbols, goToDefinition, findReferences, searchText, ...) works against it unchanged,
	 * the same way repo.fetch's checkouts already do. `created: false` means an existing worktree
	 * for this exact (source workspace, ref) pair was reused rather than recreated.
	 */
	"workspace.gitWorktreeAdd": { workspaceId: WorkspaceId; path: string; ref: string; commit: string; created: boolean };
	"workspace.gitWorktreeRemove": { workspaceId: WorkspaceId; closedIndexes: number; closedGraph: boolean; closedWatch: boolean };
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
	"workspace.localizeContext": ContextBundleResult;
}
