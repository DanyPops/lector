import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
import { createWorkspaceCacheOperations } from "../../extension/src/workspace-cache/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
	await stopDaemon?.();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	stopDaemon = undefined;
});

async function context(cwd: string): Promise<ExtensionContext> {
	const harness = createExtensionHarness(async () => {}, { cwd });
	await harness.boot();
	return harness.ctx;
}

describe("workspace cache release", () => {
	it("releases through Vehicle and re-registers on the next operation", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));
		root = mkdtempSync(join(tmpdir(), "pi-lector-release-"));
		writeFileSync(join(root, "a.ts"), "export const value = 1;\n");
		const call = { toolName: "workspace_cache", toolCallId: "release-1", context: await context(root) };
		const operations = createWorkspaceCacheOperations();
		await operations.status(root, 10, 10);

		const released = await operations.release(root, call);
		expect(released).toEqual({ workspaceId: expect.any(String), closedIndexes: 0, closedGraph: true, closedWatch: false });
		const status = await operations.status(root, 10, 10);
		expect(status.status).toBe("not-cached");
	});
});
