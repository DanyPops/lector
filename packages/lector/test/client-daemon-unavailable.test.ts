import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLectorClientAt, LectorDaemonUnavailable } from "../src/client.ts";
import { resolveLectorPaths } from "../src/constants.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";

let root: string | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("Lector daemon-unavailable diagnostics", () => {
	it("classifies a daemon stopped between operations with bounded recovery context", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-client-unavailable-"));
		const paths = resolveLectorPaths({
			env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
		});
		const daemon = await startLectorDaemon({ workspaces: new Map([["workspace-a", new InMemoryWorkspace()]]), paths });
		let stopped = false;
		stop = async () => {
			if (stopped) return;
			stopped = true;
			await daemon.stop();
		};
		const token = readFileSync(paths.token, "utf8").trim();
		let lastExit: { exitStatus: number | null; signal: string | null } | null = null;
		const client = connectLectorClientAt(`http://${daemon.host}:${daemon.port}`, token, { lastExit: () => lastExit });

		await expect(client.health()).resolves.toMatchObject({ ok: true });
		await stop();
		lastExit = { exitStatus: 1, signal: "SIGTERM" };

		let caught: unknown;
		try {
			await client.call("workspace.rawRead", { workspaceId: "workspace-a", path: "a.ts" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LectorDaemonUnavailable);
		const unavailable = caught as LectorDaemonUnavailable;
		expect(unavailable.details).toMatchObject({
			code: "lector-daemon-unavailable",
			operation: "workspace.rawRead",
			workspaceId: "workspace-a",
			processState: "exited",
			exitStatus: 1,
			signal: "SIGTERM",
		});
		// The underlying connection-refused fetch failure's own top-level error class (e.g. plain
		// "Error" vs "TypeError") is a runtime/version implementation detail, not something this
		// diagnostic depends on -- confirmed to genuinely differ between a local Bun and a CI
		// runner's Bun for the exact same connection-refused failure. Only its presence matters.
		expect(typeof unavailable.details.causeName).toBe("string");
		expect(unavailable.details.causeName.length).toBeGreaterThan(0);
		expect(unavailable.details.requestId).toMatch(/^lector-[a-z0-9]+-[a-z0-9]+$/);
		expect(unavailable.details.diagnosticCommand).toContain("journalctl --user-unit lector.service -n 50");
		expect(unavailable.message).toContain("Restart Lector");
		expect(JSON.stringify(unavailable.details)).not.toContain(token);
		expect(JSON.stringify(unavailable.details)).not.toContain(root);
	});

	it("keeps a daemon domain rejection distinct from daemon unavailability", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-client-domain-error-"));
		const paths = resolveLectorPaths({
			env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
		});
		const daemon = await startLectorDaemon({ workspaces: new Map([["workspace-a", new InMemoryWorkspace()]]), paths });
		stop = () => daemon.stop();
		const token = readFileSync(paths.token, "utf8").trim();
		const client = connectLectorClientAt(`http://${daemon.host}:${daemon.port}`, token);

		const call = client.call("workspace.rawRead", { workspaceId: "unknown", path: "a.ts" });
		await expect(call).rejects.toThrow(/UnknownWorkspace/);
		await expect(call).rejects.not.toBeInstanceOf(LectorDaemonUnavailable);
	});
});
