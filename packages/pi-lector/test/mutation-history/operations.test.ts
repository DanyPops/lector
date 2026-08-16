/**
 * createMutationHistoryOperations wraps Lector's mutation history/revert, resolving its own
 * workspace per absolute path (workspaceForPath -- a plain filesystem concern, no language
 * server needed).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests } from "../../extension/src/lector-client.ts";
import { createMutationHistoryOperations } from "../../extension/src/mutation-history/operations.ts";
import { resetLectorVehicleClientForTests } from "../../extension/src/vehicle-client.ts";
import { wireVehicleDaemon } from "../support/wire-vehicle-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed mutation history operations", () => {
	it("lists and reverts a real edit via a running Lector daemon", async () => {
		const daemon = await wireVehicleDaemon();
		stopDaemon = daemon.stop;
		const root = mkdtempSync(join(tmpdir(), "pi-lector-mutation-history-"));
		mkdirSync(join(root, ".git")); // workspaceForPath's own project-root boundary is a real .git marker, not the filesystem root fallback.
		projectDir = root;
		const filePath = join(root, "a.txt");

		// registerPath/exactEdit/rawRead are not yet migrated onto VehicleRegistry -- still go
		// through the legacy LectorClient directly for setup/assertions.
		const { workspaceId } = await daemon.client.call("workspace.registerPath", { path: root });
		const first = await daemon.client.call("workspace.exactEdit", { workspaceId, path: "a.txt", expectedHash: null, content: "v1" });
		await daemon.client.call("workspace.exactEdit", { workspaceId, path: "a.txt", expectedHash: first.newHash, content: "v2" });

		const call = await daemon.call("mutation_history");
		const ops = createMutationHistoryOperations();
		const entries = await ops.list(filePath, 10, call);
		expect(entries).toHaveLength(2);

		const secondEntry = entries.find((entry) => entry.beforeContent === "v1");
		const reverted = await ops.revert(filePath, secondEntry?.id as string, call);

		expect(reverted).toEqual({ path: "a.txt", newHash: first.newHash });
		const read = await daemon.client.call("workspace.rawRead", { workspaceId, path: "a.txt" });
		expect(read.content).toBe("v1");
	}, 20_000);
});
