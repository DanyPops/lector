import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import lectorExtension from "../../extension/src/index.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
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

describe("workspace_cache release production path", () => {
	it("returns model and replay presentation details from the registered tool", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));
		root = mkdtempSync(join(tmpdir(), "pi-lector-release-tool-"));
		const harness = createExtensionHarness(lectorExtension, { cwd: root });
		await harness.boot();
		const tool = harness.tools.get("workspace_cache")?.definition;
		if (!tool) throw new Error("workspace_cache was not registered");

		const result = await tool.execute("release-call", { action: "release", directory: root }, new AbortController().signal, () => {}, harness.ctx);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("released workspace");
		expect(result.details).toMatchObject({
			schema: "pi-lector.presentation/v1",
			action: "release",
			family: "mutation",
			payload: { action: "release", release: { workspaceId: expect.any(String) } },
		});
	});
});
