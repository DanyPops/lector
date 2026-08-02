import { existsSync, statSync } from "node:fs";
import { dirname, extname, parse } from "node:path";
import {
	connectLectorClient,
	descriptorForExtension,
	LANGUAGE_SERVER_DESCRIPTORS,
	type LectorClient,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	remoteErrorIs,
	type WorkspaceId,
} from "@danypops/lector";
import { createRetryingClient, type RetryingClient } from "@danypops/vehicle-client/daemon-client";
import { nearestGitRoot, nearestProjectRoot } from "./nearest-workspace-root.ts";

/**
 * Lazily connects to a running Lector daemon and caches, per project root,
 * the workspaceId that root registers under. Never auto-spawns the daemon:
 * a clear "start it with `lector serve`" error is preferable to guessing
 * at a lifecycle the user didn't ask for. A failed connection attempt is
 * not cached, so the very next tool call retries once the daemon is
 * actually running.
 *
 * The daemon binds a new random port on every restart. A client resolved
 * once and cached for the rest of the session would otherwise point at a
 * dead port after any later restart -- daemon-kit's createRetryingClient
 * detects that on the failing call itself (not just the first connection
 * attempt) and retries once against a freshly re-resolved client, the same
 * policy this file used to hand-roll and now shares with web-spider's
 * callWebSpider(), papyrus's callService(), and pi-packed's createNatives().
 */

type ClientConnector = () => Promise<LectorClient>;

let connector: ClientConnector = () => connectLectorClient();
// Wraps `() => connector()` rather than `connector` itself, so a test's
// setLectorClientConnectorForTests still takes effect after this retrying
// client is constructed once at module load.
const retryingClient: RetryingClient<LectorClient> = createRetryingClient(() => connector(), { label: "Lector" });
const workspaceIdByRoot = new Map<string, WorkspaceId>();

/**
 * Fires exactly once per distinct root, the moment it's first registered in this process --
 * never on a later call that reuses the cached workspaceId. The single choke point every
 * resolver (workspaceForPath, workspaceForDirectory, workspaceForCodeIntelligencePath,
 * workspaceForPathOrDirectory) funnels through, so this is genuinely "the first time any tool
 * call resolves this workspace," not just the one cwd workspace at session start.
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
	/** The registered root the target path is relative to -- a git root or the filesystem root, never a fixed session cwd. */
	root: string;
}

async function workspaceForRoot(root: string): Promise<ResolvedWorkspace> {
	const cached = workspaceIdByRoot.get(root);
	if (cached) return { workspaceId: cached, root };
	const client = await lectorClient();
	const { workspaceId } = await client.callOnce("workspace.registerPath", { path: root });
	workspaceIdByRoot.set(root, workspaceId);
	onNewWorkspace?.(root);
	return { workspaceId, root };
}

/**
 * Resolve (and cache) the Lector workspace for whatever project actually
 * contains this absolute FILE path -- never a session's original cwd.
 * Files under the same repo share one cached workspace+id; a path under a
 * different repo (or outside any repo entirely) gets its own, registered
 * on demand via workspace.registerPath. This is what makes read/write/edit
 * work for *any* absolute path in one session, exactly like Pi's built-in
 * tools always have -- not just paths under wherever the session started.
 *
 * Falls back to the filesystem root when no enclosing git repo exists:
 * unlike workspaceForDirectory, any absolute path is fair game here (a
 * dotfile in $HOME, a /tmp scratch file), so there is no smaller sensible
 * boundary to prefer over "the whole filesystem" -- this is what pi's own
 * built-in read/write/edit already allow.
 */
export function workspaceForPath(absolutePath: string): Promise<ResolvedWorkspace> {
	const directory = dirname(absolutePath);
	const root = nearestGitRoot(directory) ?? parse(directory).root;
	return workspaceForRoot(root);
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
	const root = nearestGitRoot(directory) ?? directory;
	return workspaceForRoot(root);
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
	const directory = dirname(absolutePath);
	const descriptor = descriptorForExtension(extname(absolutePath));
	const root = descriptor ? (nearestProjectRoot(directory, descriptor.rootMarkers) ?? directory) : (nearestGitRoot(directory) ?? directory);
	return workspaceForRoot(root);
}

/** Every known language's own rootMarkers, deduplicated -- see workspaceForProjectDirectory. */
const ALL_PROJECT_ROOT_MARKERS: readonly string[] = [...new Set(LANGUAGE_SERVER_DESCRIPTORS.flatMap((descriptor) => descriptor.rootMarkers))];

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
 * be any language, so this checks the union of every known language's rootMarkers. Falls back to
 * the nearest git root, then the directory itself, exactly as nearestProjectRoot already does
 * internally (it appends ".git" to whatever marker list it's given).
 */
export function workspaceForProjectDirectory(directory: string): Promise<ResolvedWorkspace> {
	const root = nearestProjectRoot(directory, ALL_PROJECT_ROOT_MARKERS) ?? directory;
	return workspaceForRoot(root);
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
 * project's own graph, with no error at all. Checks whether the path is
 * itself a real, existing directory first; only takes dirname() when it is
 * not (a file, or a not-yet-existing path).
 */
export function workspaceForPathOrDirectory(path: string): Promise<ResolvedWorkspace> {
	const isRealDirectory = existsSync(path) && statSync(path).isDirectory();
	return workspaceForDirectory(isRealDirectory ? path : dirname(path));
}

/**
 * Resolves a workspace via `resolve`, then calls `perform` with it. A daemon
 * restart wipes its in-memory workspace registry (workspace ids are not
 * persisted across restarts by design), but this module's own workspaceId
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
			workspaceIdByRoot.delete(resolved.root);
		}
	}
	throw new Error("Lector workspace resolution retry exhausted");
}

export function setLectorClientConnectorForTests(value: ClientConnector): void {
	retryingClient.reset();
	workspaceIdByRoot.clear();
	connector = value;
}

export function resetLectorClientForTests(): void {
	retryingClient.reset();
	workspaceIdByRoot.clear();
	connector = () => connectLectorClient();
}
