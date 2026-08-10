import { dirname, extname } from "node:path";
import {
	connectLectorClient,
	type LectorClient,
	LectorDaemonUnavailable,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	remoteErrorIs,
	type WorkspaceId,
	type WorkspaceResolutionRequest,
} from "@danypops/lector";
import { createRetryingClient, isLikelyStaleConnectionError, type RetryingClient } from "@danypops/vehicle-client/daemon-client";

/**
 * Lazily connects to a running Lector daemon and caches, per resolution request, the
 * workspace it resolves to. Never auto-spawns the daemon: a clear "start it with `lector serve`"
 * error is preferable to guessing at a lifecycle the user didn't ask for. A failed connection
 * attempt is not cached, so the very next tool call retries once the daemon is actually running.
 *
 * The daemon binds a new random port on every restart. A client resolved once and cached for
 * the rest of the session would otherwise point at a dead port after any later restart --
 * daemon-kit's createRetryingClient detects that on the failing call itself (not just the first
 * connection attempt) and retries once against a freshly re-resolved client, the same policy
 * this file used to hand-roll and now shares with web-spider's callWebSpider(), papyrus's
 * callService(), and pi-packed's createNatives().
 *
 * Workspace-root resolution itself (which file belongs to which project) is Lector's own
 * server-side concern -- see @danypops/lector's workspace.resolvePath and its own
 * resolveWorkspacePath. This module used to reimplement that same filesystem walk-up locally
 * (nearestGitRoot/nearestProjectRoot/nearestDeclaredWorkspaceRoot); two real, previously-shipped
 * bugs (a project's own root directory silently resolving to its parent, and two sibling
 * monorepo packages in this very repo collapsing onto the same workspaceId) traced directly to
 * that logic living in the wrong process. Every workspaceForXxx below is now a thin RPC wrapper
 * over workspace.resolvePath.
 */

type ClientConnector = () => Promise<LectorClient>;

let connector: ClientConnector = () => connectLectorClient();
// Wraps `() => connector()` rather than `connector` itself, so a test's
// setLectorClientConnectorForTests still takes effect after this retrying
// client is constructed once at module load.
const retryingClient: RetryingClient<LectorClient> = createRetryingClient(() => connector(), {
	label: "Lector",
	isStaleConnectionError: (error) => error instanceof LectorDaemonUnavailable || isLikelyStaleConnectionError(error),
});

/**
 * Fires exactly once per distinct root, the moment the daemon itself first registers it --
 * never on a later call that resolves an already-registered root. The single choke point every
 * resolver (workspaceForPath, workspaceForDirectory, workspaceForCodeIntelligencePath,
 * workspaceForPathOrDirectory) funnels through, so this is genuinely "the first time any tool
 * call resolves this workspace," not just the one cwd workspace at session start. Driven by
 * workspace.resolvePath's own authoritative `created` flag, not a local cache -- correct even
 * when a different process registered the same root moments earlier.
 */
let onNewWorkspace: ((root: string) => void) | undefined;

export function setNewWorkspaceObserver(observer: ((root: string) => void) | undefined): void {
	onNewWorkspace = observer;
}

export interface RetryingLectorClient {
	/** Transparently retries once on a stale connection -- right for a read-only or genuinely idempotent operation. */
	call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	/**
	 * Like call(), but never retries the operation itself after a failure -- only the underlying
	 * connection resets, so the *next* call()/callOnce() reconnects. Use for a mutating/non-idempotent
	 * operation, where transparently re-running it after a transport failure could double the side effect.
	 */
	callOnce<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
}

// Kept async even though its own body has no await: every call site across this package does
// `await lectorClient()`, and dropping async here would turn an internal implementation detail
// into a signature change rippling through every one of them.
export async function lectorClient(): Promise<RetryingLectorClient> {
	return {
		call: (operation, input) => retryingClient.call((client) => client.call(operation, input)),
		callOnce: (operation, input) => retryingClient.callOnce((client) => client.call(operation, input)),
	};
}

export interface ResolvedWorkspace {
	workspaceId: WorkspaceId;
	/** The root workspace.resolvePath actually registered -- a git root, a language project root, or the filesystem root, never a fixed session cwd. */
	root: string;
}

/**
 * Caches by the exact resolution request, not by the discovered root (this process no longer
 * discovers roots itself) -- a repeated call with the identical path+strategy avoids a network
 * round trip; two different files under the same repo each pay one round trip the first time,
 * same as workspace.registerPath's own idempotent registration would cost anyway. A daemon
 * restart wipes its in-memory registry; withWorkspace's own UnknownWorkspace retry (unchanged
 * below) evicts exactly the stale entry this cache produced, the same recovery it always gave.
 */
const resolutionCache = new Map<string, ResolvedWorkspace>();

function requestCacheKey(request: WorkspaceResolutionRequest): string {
	return JSON.stringify(request, Object.keys(request).sort());
}

async function resolveWorkspace(request: WorkspaceResolutionRequest): Promise<ResolvedWorkspace> {
	const key = requestCacheKey(request);
	const cached = resolutionCache.get(key);
	if (cached) return cached;
	const client = await lectorClient();
	const outcome = await client.callOnce("workspace.resolvePath", request);
	if (!outcome.found) {
		// Every strategy this function is used for (git-root/language-project-root with an
		// explicit fallback, path-or-directory) always resolves to something server-side --
		// declared-monorepo-root (the one strategy that can legitimately report not found) is
		// never routed through this function, see resolveDeclaredMonorepoRoot below.
		throw new Error(`workspace.resolvePath unexpectedly reported not-found for a fallback-guaranteed strategy: ${key}`);
	}
	const resolved: ResolvedWorkspace = { workspaceId: outcome.workspaceId, root: outcome.root };
	resolutionCache.set(key, resolved);
	if (outcome.created) onNewWorkspace?.(outcome.root);
	return resolved;
}

/**
 * Resolve (and cache) the Lector workspace for whatever project actually
 * contains this absolute FILE path -- never a session's original cwd.
 * Files under the same repo share one cached workspace+id; a path under a
 * different repo (or outside any repo entirely) gets its own, registered
 * on demand. This is what makes read/write/edit work for *any* absolute
 * path in one session, exactly like Pi's built-in tools always have.
 *
 * Falls back to the filesystem root when no enclosing git repo exists:
 * unlike workspaceForDirectory, any absolute path is fair game here (a
 * dotfile in $HOME, a /tmp scratch file), so there is no smaller sensible
 * boundary to prefer over "the whole filesystem" -- this is what pi's own
 * built-in read/write/edit already allow.
 */
export function workspaceForPath(absolutePath: string): Promise<ResolvedWorkspace> {
	return resolveWorkspace({ strategy: "git-root", path: dirname(absolutePath), fallback: "filesystem-root" });
}

/**
 * Same resolution, starting from a directory (e.g. a symbol query's cwd)
 * rather than a file's own path -- but falls back to the directory itself,
 * never the filesystem root, when no enclosing git repo exists. Widening a
 * find_symbols query's scope to the entire filesystem just because a
 * project isn't a git repo would be both wrong (nothing meaningful to find
 * outside the project) and unbounded (scanning the whole disk).
 */
export function workspaceForDirectory(directory: string): Promise<ResolvedWorkspace> {
	return resolveWorkspace({ strategy: "git-root", path: directory, fallback: "given-directory" });
}

/**
 * Honest "does a real git repo exist here at all" -- unlike workspaceForDirectory, no fallback
 * masks a non-project directory as its own root. Used by session_start to decide whether cwd
 * looks like a real project worth auto-populating a cache for, never a bare scratch/home
 * directory.
 */
export async function nearestGitWorkspaceRoot(directory: string): Promise<string | undefined> {
	const client = await lectorClient();
	const outcome = await client.call("workspace.resolvePath", { strategy: "git-root", path: directory });
	return outcome.found ? outcome.root : undefined;
}

/**
 * For any operation that spawns a real language server (find_symbols,
 * goToDefinition, documentSymbols, diagnostics, ...) -- never workspaceForPath,
 * whose filesystem-root fallback would point a real server at scanning the
 * whole disk. Falls back to the file's own containing directory instead,
 * same bound as workspaceForDirectory.
 *
 * Unlike workspaceForDirectory, prefers the file's own language's root markers
 * (tsconfig.json, go.mod, Cargo.toml, ...) over the nearest .git when both exist --
 * a monorepo subproject's own root marker is nearer and wins, so its language server
 * gets that subproject's rootUri instead of the whole repo's.
 */
export function workspaceForCodeIntelligencePath(absolutePath: string): Promise<ResolvedWorkspace> {
	return resolveWorkspace({
		strategy: "language-project-root",
		path: dirname(absolutePath),
		fallback: "given-directory",
		extension: extname(absolutePath),
	});
}

/**
 * Resolves a caller-supplied directory to its OWN nearest project root -- never the outer repo's
 * git root -- so distinct sibling packages under one monorepo stay distinct workspaces. Unlike
 * workspaceForDirectory (used by find_symbols/read/write, where one canonical workspaceId per
 * repo is exactly the point), this is for a tool whose entire premise is comparing *different*
 * scopes (find_symbols_across_projects, search_code_across_projects): collapsing two sibling
 * packages into the same workspaceId there silently duplicates one package's own results under
 * the other's name, with no error at all -- confirmed live against this monorepo
 * (packages/lector and packages/pi-lector both resolved to the same workspaceId).
 *
 * Unlike workspaceForCodeIntelligencePath, there is no single file (and therefore no known
 * extension) to pick one specific language's markers from -- a caller-supplied directory could
 * be any language, so the daemon checks the union of every known language's rootMarkers when no
 * extension is given.
 */
export function workspaceForProjectDirectory(directory: string): Promise<ResolvedWorkspace> {
	return resolveWorkspace({ strategy: "language-project-root", path: directory, fallback: "given-directory" });
}

/**
 * For an operation whose `path` genuinely means "the project/workspace itself"
 * (populateSymbolGraph, workspaceMap, hasWarmIndex) rather than one specific file
 * to act on -- unlike workspaceForCodeIntelligencePath, does NOT blindly take
 * dirname() first. A real, confirmed live bug: passing a project's own root
 * directory (e.g. "/repo", which has its own .git right there) through
 * dirname() strips its final segment, silently resolving to the *parent*
 * directory's own nearest git root instead -- for a project nested one level
 * under a broader already-registered workspace, this mixes in every sibling
 * project's own graph, with no error at all. The daemon checks whether the
 * path is itself a real, existing directory first; only takes dirname() when
 * it is not (a file, or a not-yet-existing path).
 */
export function workspaceForPathOrDirectory(path: string): Promise<ResolvedWorkspace> {
	return resolveWorkspace({ strategy: "path-or-directory", path });
}

/**
 * The nearest ancestor of an already-resolved project root whose own package.json declares that
 * project as a workspace member via npm/yarn/bun's "workspaces" field -- undefined (no
 * directory-itself/filesystem-root fallback) when no such ancestor exists, a real and expected
 * outcome for a plain single-package repo. Used only by reference-based-rename's own
 * widen-and-retry: on ReferenceBasedRenameRequiresFreshGraph, retry once against the declared
 * monorepo root instead of the narrower project the rename was first attempted against.
 * Deliberately uncached (a rare retry path, not a hot loop).
 */
export async function workspaceForDeclaredMonorepoRoot(projectRoot: string): Promise<ResolvedWorkspace | undefined> {
	const client = await lectorClient();
	const outcome = await client.callOnce("workspace.resolvePath", { strategy: "declared-monorepo-root", path: projectRoot });
	if (!outcome.found) return undefined;
	if (outcome.created) onNewWorkspace?.(outcome.root);
	return { workspaceId: outcome.workspaceId, root: outcome.root };
}

/**
 * Resolves a workspace via `resolve`, then calls `perform` with it. A daemon
 * restart wipes its in-memory workspace registry (workspace ids are not
 * persisted across restarts by design), but this module's own resolution
 * cache does not know that on its own -- a call through a stale cached id
 * fails with UnknownWorkspace even though the underlying files on disk
 * never changed. On exactly that failure, the stale cache entry is dropped
 * and the whole flow (resolve, then perform) retries once against a
 * freshly re-registered workspace -- re-registering the same root always
 * yields the same workspaceId (deriveWorkspaceId is a deterministic hash
 * of the path), so this is a safe, idempotent recovery, not a guess.
 */
export async function withWorkspace<T>(resolve: () => Promise<ResolvedWorkspace>, perform: (resolved: ResolvedWorkspace) => Promise<T>): Promise<T> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const resolved = await resolve();
		try {
			return await perform(resolved);
		} catch (error) {
			if (attempt === 1 || !remoteErrorIs(error, "UnknownWorkspace")) throw error;
			forgetWorkspaceId(resolved.root);
		}
	}
	throw new Error("Lector workspace resolution retry exhausted");
}

/**
 * Drops every cache entry resolved to this root without retrying anything itself -- the batch
 * sibling of withWorkspace's own single-workspace recovery, for a caller (cross-workspace
 * search's fan-out) that resolves many roots at once and needs to evict only the specific ones a
 * daemon restart actually invalidated, not the whole cache. A root can appear under more than one
 * cache key (workspaceForPath and workspaceForDirectory can each independently resolve to the
 * same root for related paths), so this scans by value, not a single key lookup.
 */
export function forgetWorkspaceId(root: string): void {
	for (const [key, resolved] of resolutionCache) {
		if (resolved.root === root) resolutionCache.delete(key);
	}
}

export function setLectorClientConnectorForTests(value: ClientConnector): void {
	retryingClient.reset();
	resolutionCache.clear();
	connector = value;
}

export function resetLectorClientForTests(): void {
	retryingClient.reset();
	resolutionCache.clear();
	connector = () => connectLectorClient();
}
