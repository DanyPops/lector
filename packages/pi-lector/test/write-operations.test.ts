/**
 * A write racing against a concurrent external change still lands the
 * write tool's intended content, transparently retried, bounded to a
 * fixed number of attempts -- StaleExpectedHash never surfaces to the
 * caller for `write`, unlike `edit`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LectorClient, remoteErrorIs } from "@danypops/lector";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { createLectorWriteOperations } from "../extension/src/write-operations.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed write tool", () => {
	it("retries transparently past one interposing external change and lands its own content", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-write-race-"));
		const absolutePath = join(projectDir, "a.txt");
		writeFileSync(absolutePath, "original");
		const { workspaceId } = await daemon.client.call("workspace.registerPath", { path: projectDir });

		let interposed = false;
		const racingClient: LectorClient = {
			...daemon.client,
			call: async (operation, input) => {
				if (operation === "workspace.exactEdit" && !interposed) {
					interposed = true;
					// A concurrent external change lands after write-operations observed the
					// current hash but before its own exactEdit commits.
					const current = await daemon.client.call("workspace.rawRead", { workspaceId, path: "a.txt" });
					await daemon.client.call("workspace.exactEdit", {
						workspaceId,
						path: "a.txt",
						expectedHash: current.hash,
						content: "concurrent external change",
					});
				}
				return daemon.client.call(operation, input);
			},
		} as LectorClient;
		setLectorClientConnectorForTests(() => Promise.resolve(racingClient));

		const ops = createLectorWriteOperations();
		await ops.writeFile(absolutePath, "final intended content");

		expect(readFileSync(absolutePath, "utf-8")).toBe("final intended content");
	});

	it("gives up after a bounded number of attempts rather than retrying forever", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-write-persistent-race-"));
		const absolutePath = join(projectDir, "a.txt");
		writeFileSync(absolutePath, "original");
		const { workspaceId } = await daemon.client.call("workspace.registerPath", { path: projectDir });

		let exactEditAttempts = 0;
		const alwaysRacingClient: LectorClient = {
			...daemon.client,
			call: async (operation, input) => {
				if (operation === "workspace.exactEdit") {
					exactEditAttempts++;
					// Every single attempt loses the race -- a persistently hostile racer.
					const current = await daemon.client.call("workspace.rawRead", { workspaceId, path: "a.txt" });
					await daemon.client.call("workspace.exactEdit", {
						workspaceId,
						path: "a.txt",
						expectedHash: current.hash,
						content: `external change #${exactEditAttempts}`,
					});
				}
				return daemon.client.call(operation, input);
			},
		} as LectorClient;
		setLectorClientConnectorForTests(() => Promise.resolve(alwaysRacingClient));

		const ops = createLectorWriteOperations();
		let caught: unknown;
		try {
			await ops.writeFile(absolutePath, "never lands");
		} catch (error) {
			caught = error;
		}

		expect(remoteErrorIs(caught, "StaleExpectedHash")).toBe(true);
		expect(exactEditAttempts).toBeGreaterThan(0);
		expect(exactEditAttempts).toBeLessThanOrEqual(3);
	});
});
