import { dirname, parse } from "node:path";
import { connectLectorClient, type LectorClient, type WorkspaceId } from "@danypops/lector";
import { nearestGitRoot } from "./nearest-workspace-root.ts";

/**
 * Lazily connects to a running Lector daemon and caches, per project root,
 * the workspaceId that root registers under. Never auto-spawns the daemon:
 * a clear "start it with `lector serve`" error is preferable to guessing
 * at a lifecycle the user didn't ask for. A failed connection attempt is
 * not cached, so the very next tool call retries once the daemon is
 * actually running.
 */

type ClientConnector = () => Promise<LectorClient>;

let connector: ClientConnector = () => connectLectorClient();
let cachedClient: Promise<LectorClient> | undefined;
const workspaceIdByRoot = new Map<string, WorkspaceId>();

export async function lectorClient(): Promise<LectorClient> {
	if (!cachedClient) {
		cachedClient = connector().catch((error: unknown) => {
			cachedClient = undefined;
			throw error;
		});
	}
	return cachedClient;
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
