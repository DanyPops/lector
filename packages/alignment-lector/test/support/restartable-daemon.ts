import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace, resolveLectorPaths, startLectorDaemon } from "@danypops/lector";

/**
 * A real Lector daemon discoverable through its own handle file, so a client that re-reads that
 * handle on every reconnect (createRetryingLectorClient) can find it exactly like the real
 * CLI/service does -- unlike startIsolatedDaemon's connectLectorClientAt, which binds a client to
 * one fixed host:port and can never rediscover a genuinely different one.
 */
export async function startRestartableDaemon() {
	const root = mkdtempSync(join(tmpdir(), "alignment-lector-restart-"));
	const paths = resolveLectorPaths({ env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root } });
	let daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
	return {
		paths,
		/** Stops the current daemon process and boots a fresh one on the identical paths -- a new random port, exactly like a real restart under Armada/systemd. */
		async restart() {
			await daemon.stop();
			daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
		},
		async stop() {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
