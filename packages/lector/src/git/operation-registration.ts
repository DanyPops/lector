/** Git operation contracts delegate to GitHandlers so every entry point shares one implementation and the same domain errors. */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { UnsafeGitArgument } from "../git/assert-safe-git-argument.ts";
import { InvalidGitSearchPattern } from "../git/invalid-search-pattern.ts";
import { GitRevisionNotFound } from "../git/revision-not-found.ts";
import { WORKSPACE_READ_PERMISSION, WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import { NotAGitRepository, NotAWorktree, SymbolQueryUnavailable, WorkspaceReleaseBlocked } from "../service/errors.ts";
import type { GitHandlers } from "../service/git-handlers.ts";
import type { GitWorktreeHandlers } from "../service/git-worktree-handlers.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import {
	gitDiffInputSchema,
	gitGrepHistoryInputSchema,
	gitGrepInputSchema,
	gitIsAncestorInputSchema,
	gitListFilesInputSchema,
	gitLogInputSchema,
	gitShowFileInputSchema,
	gitStatusInputSchema,
	gitWorktreeAddInputSchema,
	gitWorktreeRemoveInputSchema,
} from "./input-schemas.ts";

const OWNER = "lector-git";

const READ_PERMISSIONS = [WORKSPACE_READ_PERMISSION];
const WRITE_PERMISSIONS = [WORKSPACE_WRITE_PERMISSION];

/** Provisional bounds, not yet tuned per-operation against real usage -- a later, risk-prioritized pass. */
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 8 * 1024 * 1024 };
/** History search enforces its caller-supplied deadline internally; the registry ceiling allows the largest accepted deadline to finish cleanup. */
const HISTORY_SEARCH_LIMITS = { defaultTimeoutMs: 120_000, maxTimeoutMs: 120_000, maxRequestBytes: 128 * 1024, maxResponseBytes: 8 * 1024 * 1024 };
/** A real `git worktree add`/`remove` (disk I/O, possibly a first-time clone-sized checkout) needs materially more headroom than the read-only status/log/diff queries above. */
const WORKTREE_LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 8_192, maxResponseBytes: 8_192 };

/** Every failure requireGitRepository (shared by all 3 operations) can actually throw, declared once. */
const GIT_REPOSITORY_ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	{ code: "symbol-query-unavailable", description: "the workspace has no known root path (not registered from a real filesystem location)" },
	{ code: "not-a-git-repository", description: "the workspace's root is not inside a git repository" },
];
/** Every failure a ref-scoped Tier 1 query (showFile/grep/listFiles/isAncestor) can actually throw beyond GIT_REPOSITORY_ERRORS -- a validated ref/ancestorRef that starts with "-", or one that simply doesn't resolve. */
const TIER1_REF_ERRORS = [
	...GIT_REPOSITORY_ERRORS,
	{ code: "unsafe-git-argument", description: 'ref (or ancestorRef) starts with "-" (git argv-flag injection guard)' },
	{ code: "git-revision-not-found", description: "ref (or ancestorRef) does not resolve in this repository" },
];
const HISTORY_SEARCH_ERRORS = [
	...GIT_REPOSITORY_ERRORS,
	{ code: "invalid-git-search-pattern", description: "pattern is not a valid extended regular expression" },
];
const WORKTREE_ADD_ERRORS = [
	...GIT_REPOSITORY_ERRORS,
	{ code: "unsafe-git-argument", description: 'ref starts with "-" (git argv-flag injection guard)' },
	{ code: "git-revision-not-found", description: "ref does not resolve in this repository" },
	{ code: "workspace-release-blocked", description: "forceRefresh could not tear down the existing worktree -- it is still actively in use" },
];
const WORKTREE_REMOVE_ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	{ code: "symbol-query-unavailable", description: "the workspace has no known root path" },
	{ code: "not-a-worktree", description: "the workspace's root is not a linked git worktree created by workspace.gitWorktreeAdd" },
	{ code: "workspace-release-blocked", description: "the worktree is still actively in use (a warm index lease, a background job, or a live watch)" },
];

/** Maps requireGitRepository's 3 real domain errors onto properly coded/categorized VehicleErrors, preserving the original as `cause`. */
const mapGitError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAGitRepository, category: "validation", code: "not-a-git-repository" },
]);
/** Maps requireGitRepository's errors plus a ref-scoped Tier 1 query's own unsafe-argument/missing-revision failures. */
const mapTier1RefError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAGitRepository, category: "validation", code: "not-a-git-repository" },
	{ errorClass: UnsafeGitArgument, category: "validation", code: "unsafe-git-argument" },
	{ errorClass: GitRevisionNotFound, category: "validation", code: "git-revision-not-found" },
]);
const mapHistorySearchError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAGitRepository, category: "validation", code: "not-a-git-repository" },
	{ errorClass: InvalidGitSearchPattern, category: "validation", code: "invalid-git-search-pattern" },
]);
const mapWorktreeAddError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAGitRepository, category: "validation", code: "not-a-git-repository" },
	{ errorClass: UnsafeGitArgument, category: "validation", code: "unsafe-git-argument" },
	{ errorClass: GitRevisionNotFound, category: "validation", code: "git-revision-not-found" },
	{ errorClass: WorkspaceReleaseBlocked, category: "conflict", code: "workspace-release-blocked" },
]);
const mapWorktreeRemoveError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAWorktree, category: "validation", code: "not-a-worktree" },
	{ errorClass: WorkspaceReleaseBlocked, category: "conflict", code: "workspace-release-blocked" },
]);

/** Registers the Git operation contracts without duplicating GitHandlers behavior. */
export function registerGitOperations(
	operationRegistry: VehicleRegistry,
	registry: MutableRegistry,
	handlers: GitHandlers,
	worktreeHandlers: GitWorktreeHandlers,
): void {
	const gitStatus = defineVehicleOperation({
		name: "workspace.gitStatus",
		version: 1,
		description: "Reports a git workspace's current status (staged/unstaged/untracked files).",
		input: gitStatusInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GIT_REPOSITORY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitStatus, () => (context) => mapGitError(() => handlers["workspace.gitStatus"](registry, context.input))),
	);

	const gitLog = defineVehicleOperation({
		name: "workspace.gitLog",
		version: 1,
		description: "Lists a git workspace's recent commits, most recent first, bounded by maxCount.",
		input: gitLogInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GIT_REPOSITORY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitLog, () => (context) => mapGitError(() => handlers["workspace.gitLog"](registry, context.input))),
	);

	const gitDiff = defineVehicleOperation({
		name: "workspace.gitDiff",
		version: 1,
		description: "Shows a git workspace's current diff (ref omitted means the working tree), bounded by maxBytes.",
		input: gitDiffInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GIT_REPOSITORY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitDiff, () => (context) => mapGitError(() => handlers["workspace.gitDiff"](registry, context.input))),
	);

	const gitShowFile = defineVehicleOperation({
		name: "workspace.gitShowFile",
		version: 1,
		description: "A path's exact blob content at `ref`, without checking anything out. Undefined content means the path did not exist at that ref.",
		input: gitShowFileInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: TIER1_REF_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitShowFile, () => (context) => mapTier1RefError(() => handlers["workspace.gitShowFile"](registry, context.input))),
	);

	const gitGrep = defineVehicleOperation({
		name: "workspace.gitGrep",
		version: 1,
		description:
			"Text search across `ref`'s own tree, without checking anything out -- the ref-scoped equivalent of workspace.searchText. " +
			"Optional pathspecs narrow the search (glob-based); bounded by maxMatches and maxBytes.",
		input: gitGrepInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: TIER1_REF_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitGrep, () => (context) => mapTier1RefError(() => handlers["workspace.gitGrep"](registry, context.input))),
	);

	const gitGrepHistory = defineVehicleOperation({
		name: "workspace.gitGrepHistory",
		version: 1,
		description:
			"Bounded extended-regex search across commit trees reachable from every ref, in deterministic topological pages. " +
			"Excludes binary files and deduplicates exact path/line/text tuples while retaining commit provenance.",
		input: gitGrepHistoryInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: HISTORY_SEARCH_LIMITS,
		errors: HISTORY_SEARCH_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitGrepHistory, () => (context) => mapHistorySearchError(() => handlers["workspace.gitGrepHistory"](registry, context.input))),
	);

	const gitListFiles = defineVehicleOperation({
		name: "workspace.gitListFiles",
		version: 1,
		description:
			"Every file path present in `ref`'s own tree, without checking anything out. Optional pathspecs narrow the listing " +
			"(prefix-based, not glob-based like gitGrep's); bounded by maxResults.",
		input: gitListFilesInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: TIER1_REF_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitListFiles, () => (context) => mapTier1RefError(() => handlers["workspace.gitListFiles"](registry, context.input))),
	);

	const gitIsAncestor = defineVehicleOperation({
		name: "workspace.gitIsAncestor",
		version: 1,
		description:
			'True iff ancestorRef is a real ancestor of (or the exact same commit as) ref -- the backport/reachability check for "was this commit ported to this branch".',
		input: gitIsAncestorInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: TIER1_REF_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitIsAncestor, () => (context) => mapTier1RefError(() => handlers["workspace.gitIsAncestor"](registry, context.input))),
	);

	const gitWorktreeAdd = defineVehicleOperation({
		name: "workspace.gitWorktreeAdd",
		version: 1,
		description:
			"Materializes a real, disposable, read-only project at `ref` via a detached git worktree and registers it as its own workspace -- " +
			"findSymbols/goToDefinition/findReferences/searchText all work against the returned workspaceId unchanged. Reuses an existing worktree " +
			"for the same (workspace, ref) pair unless forceRefresh is set.",
		input: gitWorktreeAddInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "safe" },
		limits: WORKTREE_LIMITS,
		errors: WORKTREE_ADD_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitWorktreeAdd, () => (context) => mapWorktreeAddError(() => worktreeHandlers["workspace.gitWorktreeAdd"](registry, context.input))),
	);

	const gitWorktreeRemove = defineVehicleOperation({
		name: "workspace.gitWorktreeRemove",
		version: 1,
		description:
			"Releases a workspace.gitWorktreeAdd-created workspace and removes its backing worktree from disk and git's own admin list, under the same active-use guards as workspace.release.",
		input: gitWorktreeRemoveInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "destructive",
		idempotency: { mode: "safe" },
		limits: WORKTREE_LIMITS,
		errors: WORKTREE_REMOVE_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			gitWorktreeRemove,
			() => (context) => mapWorktreeRemoveError(() => worktreeHandlers["workspace.gitWorktreeRemove"](registry, context.input)),
		),
	);
}

export { READ_PERMISSIONS as GIT_READ_PERMISSIONS, WRITE_PERMISSIONS as GIT_WORKTREE_WRITE_PERMISSIONS };
