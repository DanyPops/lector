import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonPaths } from "@danypops/vehicle-server/paths";
import { createRetryingLectorClient, type LectorRestartEvent } from "../src/client.ts";
import { resolveLectorPaths } from "../src/constants.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";

let activeStop: (() => Promise<void>) | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
	await activeStop?.();
	activeStop = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedPaths(): { paths: DaemonPaths; workspaceRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-restart-identity-"));
	const workspaceRoot = mkdtempSync(join(tmpdir(), "lector-restart-identity-workspace-"));
	tempDirs.push(root, workspaceRoot);
	return { paths: resolveLectorPaths({ env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root } }), workspaceRoot };
}

async function bootDaemon(paths: DaemonPaths) {
	const daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
	activeStop = () => daemon.stop();
	return daemon;
}

/** Stops `daemon` and boots a fresh one on the identical paths -- a new random port, exactly like a real restart under Armada/systemd. */
async function restartDaemon(daemon: { stop(): Promise<void> }, paths: DaemonPaths) {
	await daemon.stop();
	return await bootDaemon(paths);
}

describe("createRetryingLectorClient", () => {
	it("never fires onRestart for the very first successful connect", async () => {
		const { paths, workspaceRoot } = isolatedPaths();
		await bootDaemon(paths);
		const client = createRetryingLectorClient({ paths });
		const events: LectorRestartEvent[] = [];
		client.onRestart((event) => events.push(event));

		await expect(client.call("workspace.registerPath", { path: workspaceRoot })).resolves.toBeDefined();
		expect(events).toHaveLength(0);
	});

	it("fires onRestart exactly once with distinct identities when the daemon restarts on the same paths", async () => {
		const { paths, workspaceRoot } = isolatedPaths();
		const first = await bootDaemon(paths);
		const client = createRetryingLectorClient({ paths });
		const events: LectorRestartEvent[] = [];
		client.onRestart((event) => events.push(event));

		await client.call("workspace.registerPath", { path: workspaceRoot });
		expect(events).toHaveLength(0);

		await restartDaemon(first, paths);

		await expect(client.call("workspace.registerPath", { path: workspaceRoot })).resolves.toBeDefined();
		expect(events).toHaveLength(1);
		expect(events[0]?.previousIdentity).not.toBe(events[0]?.currentIdentity);
		expect(events[0]?.previousIdentity).toMatch(/^\d+:\d+$/);
		expect(events[0]?.currentIdentity).toMatch(/^\d+:\d+$/);
	});

	it("transparently reconnects call() against the freshly restarted daemon instead of surfacing a stale-connection error", async () => {
		const { paths, workspaceRoot } = isolatedPaths();
		const first = await bootDaemon(paths);
		const client = createRetryingLectorClient({ paths });
		await expect(client.call("workspace.registerPath", { path: workspaceRoot })).resolves.toBeDefined();

		await restartDaemon(first, paths);

		// The underlying cached client still points at the old, now-dead port; call() must detect
		// that as a stale connection and transparently retry against the newly discovered one.
		await expect(client.call("workspace.registerPath", { path: workspaceRoot })).resolves.toBeDefined();
	});
});
