import { dirname, parse } from "node:path";
import {
	connectLectorClient,
	type LectorClient,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	remoteErrorIs,
	type WorkspaceId,
} from "@danypops/lector";
import { nearestGitRoot } from "./nearest-workspace-root.ts";

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
 * dead port after any later restart -- lectorClient()'s returned .call()
 * detects that on the failing call itself (not just the first connection
 * attempt) and retries once against a freshly re-resolved client, matching
 * the pattern already proven in this house's papyrusClient()/callService().
 */

type ClientConnector = () => Promise<LectorClient>;

let connector: ClientConnector = () => connectLectorClient();
let cachedClient: Promise<LectorClient> | undefined;
const workspaceIdByRoot = new Map<string, WorkspaceId>();

async function resolveClient(): Promise<LectorClient> {
	if (!cachedClient) {
		cachedClient = connector().catch((error: unknown) => {
			cachedClient = undefined;
			throw error;
		});
	}
	return cachedClient;
}

/**
 * True when `error` means the connection itself is bad (the daemon
 * restarted on a new port since this client was cached, or died outright)
 * -- worth invalidating the cache and retrying once. False for a genuine
 * domain-level rejection (e.g. UnknownWorkspace), which a retry cannot fix
 * and would only mask.
 */
function isStaleConnectionError(error: unknown): boolean {
	if (error instanceof TypeError) return true; // fetch()'s own connection-refused/DNS-failure shape
	if (!(error instanceof Error)) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	return /fetch failed|unable to connect|network|socket|ECONNRESET|ECONNREFUSED|connection refused/i.test(error.message);
}

export interface RetryingLectorClient {
	call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
}

export async function lectorClient(): Promise<RetryingLectorClient> {
	return {
		async call(operation, input) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const client = await resolveClient();
				try {
					return await client.call(operation, input);
				} catch (error) {
					cachedClient = undefined;
					if (attempt === 1 || !isStaleConnectionError(error)) throw error;
				}
			}
			throw new Error("Lector daemon client retry exhausted");
		},
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
	const { workspaceId } = await client.call("workspace.registerPath", { path: root });
	workspaceIdByRoot.set(root, workspaceId);
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
	cachedClient = undefined;
	workspaceIdByRoot.clear();
	connector = value;
}

export function resetLectorClientForTests(): void {
	cachedClient = undefined;
	workspaceIdByRoot.clear();
	connector = () => connectLectorClient();
}
