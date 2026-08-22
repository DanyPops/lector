import { LANGUAGE_SERVER_DESCRIPTORS } from "../code-intelligence/language-server-descriptor.ts";
import { deriveWorkspaceId, type WorkspaceId } from "../workspace/workspace-id.ts";

// Re-exported for import-path stability -- WorkspaceId/deriveWorkspaceId moved to
// workspace/workspace-id.ts (a real branded value-object type, matching ContentHash/SymbolNodeId),
// out of this error-catalog file which was never their real domain home.
export { deriveWorkspaceId, type WorkspaceId };

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

/** Raised by workspace.cacheWalkedFiles/workspace.cacheFailures when the workspace has never completed a population -- there is no generation to page through detail from at all, distinct from cacheStatus's own "not-cached" (a status, not an error) because these two operations only ever make sense given a completed generation to begin with. */
export class NoCompletedGeneration extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" has no completed symbol-graph generation yet; populate it first`);
		this.name = "NoCompletedGeneration";
	}
}

/** Raised when the negotiated backend has no rename/prepareRename support at all (e.g. a tree-sitter fallback, or a real server that never advertised renameProvider). */
export class RenameNotSupported extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}"'s symbol index does not support rename -- the negotiated backend never advertised renameProvider`);
		this.name = "RenameNotSupported";
	}
}

/** Raised when the negotiated backend has no documentHighlights support at all (e.g. a tree-sitter/compiler-API fallback with no such LSP request to make). */
export class DocumentHighlightsNotSupported extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(
			`workspace "${workspaceId}"'s symbol index does not support documentHighlights -- the negotiated backend has no textDocument/documentHighlight request to make`,
		);
		this.name = "DocumentHighlightsNotSupported";
	}
}

/** Raised when a git operation targets a workspace whose root is not inside a git repository -- a real, expected case, not every registered workspace is one. */
export class NotAGitRepository extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" is not inside a git repository`);
		this.name = "NotAGitRepository";
	}
}

/** Raised when workspace.gitWorktreeRemove targets a workspace whose root is not a linked git worktree (no `.git` file with a `gitdir:` pointer back through a `/worktrees/` admin entry) -- refuses rather than running `git worktree remove` against an arbitrary registered project. */
export class NotAWorktree extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" is not a git worktree created by workspace.gitWorktreeAdd`);
		this.name = "NotAWorktree";
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

/** Raised by repo.evictCache when the target cache entry's resolved path is still a currently-registered workspace -- evicting would delete a live workspace's backing storage out from under every other operation still reading it. Call workspace.release first. */
export class RepoCacheEntryInUse extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`cannot evict: still registered as workspace "${workspaceId}" -- call workspace.release first`);
		this.name = "RepoCacheEntryInUse";
	}
}

export class PackageSourceResolverNotConfigured extends Error {
	constructor() {
		super("package.resolveSource requires a service constructed with repository fetching");
		this.name = "PackageSourceResolverNotConfigured";
	}
}

/** Raised by package.removeSource/cleanSources when the entry's own recorded workspaceId is still a currently-registered workspace, mirroring RepoCacheEntryInUse's identical limitation for repo.evictCache. Call workspace.release first. */
export class PackageSourceEntryInUse extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`cannot remove: still registered as workspace "${workspaceId}" -- call workspace.release first`);
		this.name = "PackageSourceEntryInUse";
	}
}

/**
 * Raised by workspace.release when tearing it down now would pull storage/processes out from
 * under work that is still using this workspace. Fails closed rather than racing a lease
 * completion, an in-flight populateSymbolGraph job, or a still-registered workspace.watch
 * subscription -- the caller resolves the specific condition (let the query finish, wait for the
 * job, workspace.unwatch first) and retries, rather than release silently tearing down what it
 * shouldn't or blocking forever.
 */
export class WorkspaceReleaseBlocked extends Error {
	constructor(
		readonly workspaceId: WorkspaceId,
		readonly reason: "active-lease" | "active-job" | "active-watch",
	) {
		const explanation =
			reason === "active-lease"
				? "a code-intelligence query is still using this workspace's warm index"
				: reason === "active-job"
					? "a background populateSymbolGraph job is still running for this workspace"
					: "this workspace still has an active workspace.watch subscription -- workspace.unwatch it first";
		super(`cannot release workspace "${workspaceId}": ${explanation}`);
		this.name = "WorkspaceReleaseBlocked";
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

/**
 * Refuses an auto-population trigger against a resolved root that looks like a broad host
 * directory (home directory, an XDG config/cache/data root, a dotfile directory) rather than a
 * real project -- live evidence: a stale ~/.config registration produced a 500-file population
 * over unrelated application caches, and ~/.pi/agent queued behind real projects before failing
 * UnsupportedLanguage on files that were never a real project's source. Pass allowBroadRoot:
 * true to proceed anyway -- an explicit, auditable opt-in, never a silent default.
 */
export class BroadNonProjectRoot extends Error {
	constructor(readonly rootPath: string) {
		super(`"${rootPath}" looks like a broad host directory, not a real project -- refusing to auto-populate without allowBroadRoot: true`);
		this.name = "BroadNonProjectRoot";
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

export class MutationTransactionNotFound extends Error {
	constructor(readonly transactionId: string) {
		super(
			`no mutation transaction "${transactionId}" -- it was never recorded, already evicted (bounded per-file history), or belongs to a different workspace`,
		);
		this.name = "MutationTransactionNotFound";
	}
}

/** Mirrors MutationRevertStale, but for a whole rename/multi-file transaction: even one stale member refuses the entire revert, never a partial one. */
export class MutationTransactionRevertStale extends Error {
	constructor(
		readonly transactionId: string,
		readonly path: string,
	) {
		super(`"${path}" has changed since transaction "${transactionId}" was applied -- refusing to revert any part of it over a change it never knew about`);
		this.name = "MutationTransactionRevertStale";
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

/** autoPopulate needs explicit population bounds to check freshness/populate against -- never silently defaulted, since a wrong guessed bound could populate (and cache) the wrong scope. */
export class AutoPopulateRequiresBounds extends Error {
	constructor(readonly operation: string) {
		super(`${operation}'s autoPopulate requires maxFiles and maxSymbolsPerFile to be set explicitly`);
		this.name = "AutoPopulateRequiresBounds";
	}
}

/** Raised when a workspace's own WorkspacePort implementation does not also implement FileTreePort (e.g. a read-only fetched-repo checkout). */
export class WorkspaceDoesNotSupportFileTree extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`workspace "${workspaceId}" does not support directory-tree operations`);
		this.name = "WorkspaceDoesNotSupportFileTree";
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

export class WarmIndexCapacityExceeded extends Error {
	constructor(
		readonly languageId: string,
		readonly maxActive: number,
		readonly languageLimit: number,
	) {
		super(
			`no idle code-intelligence server can be evicted to admit "${languageId}" within global capacity ${maxActive} and language capacity ${languageLimit}`,
		);
		this.name = "WarmIndexCapacityExceeded";
	}
}

/** Raised by releaseWorkspaceIfIdle when a warm index for this workspace still has an active lease -- the caller must let the in-flight query finish and retry, never force-closed out from under it. */
export class WarmIndexInUse extends Error {
	constructor(readonly workspaceId: string) {
		super(`cannot release workspace "${workspaceId}": a warm code-intelligence index for it still has an active lease`);
		this.name = "WarmIndexInUse";
	}
}

/** Raised when one admission class reaches its configured warm-index queue bound. */
export class WarmIndexAdmissionQueueFull extends Error {
	constructor(
		readonly languageId: string,
		readonly maxQueued: number,
		readonly workKind: "foreground" | "background" = "background",
	) {
		super(`${workKind} admission for language "${languageId}" is already waiting at capacity (${maxQueued} queued); retry later`);
		this.name = "WarmIndexAdmissionQueueFull";
	}
}

/** Raised when a bounded warm-index admission wait expires. */
export class WarmIndexAdmissionQueueTimedOut extends Error {
	constructor(
		readonly languageId: string,
		readonly timeoutMs: number,
		readonly workKind: "foreground" | "background" = "background",
	) {
		super(`${workKind} admission for language "${languageId}" waited ${timeoutMs}ms for a warm-index slot and gave up`);
		this.name = "WarmIndexAdmissionQueueTimedOut";
	}
}
