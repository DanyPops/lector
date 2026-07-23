/**
 * Checklist (task ef213eb1): per-cwd workspace registration is cached, and
 * a missing daemon fails clearly rather than hanging or silently bypassing
 * Lector.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { connectLectorClient, resolveLectorPaths, type LectorClient } from "@danypops/lector";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests, workspaceIdForCwd } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

afterEach(() => {
	resetLectorClientForTests();
});

describe("workspaceIdForCwd", () => {
	it("registers a distinct cwd exactly once, even across many calls", async () => {
		const daemon = startIsolatedLectorDaemon();
		let registerCalls = 0;
		const countingClient: LectorClient = {
			...daemon.client,
			call: (operation, input) => {
				if (operation === "workspace.registerPath") registerCalls++;
				return daemon.client.call(operation, input);
			},
		} as LectorClient;
		setLectorClientConnectorForTests(() => Promise.resolve(countingClient));

		const projectDir = mkdtempSync(join(tmpdir(), "pi-lector-project-"));
		try {
			await workspaceIdForCwd(projectDir);
			await workspaceIdForCwd(projectDir);
			await workspaceIdForCwd(projectDir);

			expect(registerCalls).toBe(1);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("two distinct cwds receive two distinct workspaceIds", async () => {
		const daemon = startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const projectA = mkdtempSync(join(tmpdir(), "pi-lector-a-"));
		const projectB = mkdtempSync(join(tmpdir(), "pi-lector-b-"));
		try {
			const idA = await workspaceIdForCwd(projectA);
			const idB = await workspaceIdForCwd(projectB);
			expect(idA).not.toBe(idB);
		} finally {
			rmSync(projectA, { recursive: true, force: true });
			rmSync(projectB, { recursive: true, force: true });
			await daemon.stop();
		}
	});
});

describe("lectorClient with no daemon reachable", () => {
	it("fails with a clear error naming `lector serve`, never hangs or silently bypasses Lector", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lector-no-daemon-"));
		const paths = resolveLectorPaths({
			env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
		});
		setLectorClientConnectorForTests(() => connectLectorClient({ paths }));

		try {
			await expect(workspaceIdForCwd("/tmp")).rejects.toThrow(/lector serve/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
