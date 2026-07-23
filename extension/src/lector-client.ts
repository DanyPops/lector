import { connectLectorClient, type LectorClient, type WorkspaceId } from "@danypops/lector";

/**
 * Lazily connects to a running Lector daemon and caches, per cwd, the
 * workspaceId that cwd registers under. Never auto-spawns the daemon:
 * consistent with Papyrus's own posture, a clear "start it with
 * `lector serve`"-shaped error is preferable to guessing at a lifecycle
 * the user didn't ask for. A failed connection attempt is not cached, so
 * the very next tool call retries once the daemon is actually running.
 */

type ClientConnector = () => Promise<LectorClient>;

let connector: ClientConnector = () => connectLectorClient();
let cachedClient: Promise<LectorClient> | undefined;
const workspaceIdByCwd = new Map<string, WorkspaceId>();

export async function lectorClient(): Promise<LectorClient> {
	if (!cachedClient) {
		cachedClient = connector().catch((error: unknown) => {
			cachedClient = undefined;
			throw error;
		});
	}
	return cachedClient;
}

/** Resolve (and cache) the Lector workspaceId a given cwd registers under. */
export async function workspaceIdForCwd(cwd: string): Promise<WorkspaceId> {
	const cached = workspaceIdByCwd.get(cwd);
	if (cached) return cached;
	const client = await lectorClient();
	const { workspaceId } = await client.call("workspace.registerPath", { path: cwd });
	workspaceIdByCwd.set(cwd, workspaceId);
	return workspaceId;
}

export function setLectorClientConnectorForTests(value: ClientConnector): void {
	cachedClient = undefined;
	workspaceIdByCwd.clear();
	connector = value;
}

export function resetLectorClientForTests(): void {
	cachedClient = undefined;
	workspaceIdByCwd.clear();
	connector = () => connectLectorClient();
}
