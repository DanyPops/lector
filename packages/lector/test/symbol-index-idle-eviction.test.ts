/**
 * A long-lived, dynamic-workspace daemon accumulates one warm symbol index
 * per project ever queried over its uptime, with no natural point at which
 * a project "stops mattering" -- unbounded resource growth otherwise.
 * Oculus hit and fixed the identical problem for its own gopls warm pool
 * (TTL eviction, 30-minute default); this is the same fix for Lector.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { startDaemon } from "@danypops/vehicle-server/daemon";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { buildLectorApp } from "../src/daemon.ts";
import { createLectorService, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanup: (() => void | Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function clientFor(host: string, port: number, token: string) {
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${host}:${port}`, token, { label: "Lector" });
}

describe("LectorService.reapIdleSymbolIndexes", () => {
	it("closes and removes an index untouched for longer than maxIdleMs, and reports how many", async () => {
		let closed = false;
		const fakeIndex = {
			provenance: TEST_SEMANTIC_PROVENANCE,
			findSymbols: async () => symbolSearchResult(),
			close: async () => {
				closed = true;
			},
		};
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]), { createSymbolIndex: () => fakeIndex });

		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: process.cwd() });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "anything" }); // warms the fake index

		await sleep(30);
		const reapedWhileFresh = await service.reapIdleSymbolIndexes(10_000);
		expect(reapedWhileFresh).toBe(0);
		expect(closed).toBe(false);

		const reapedWhenIdle = await service.reapIdleSymbolIndexes(10);
		expect(reapedWhenIdle).toBe(1);
		expect(closed).toBe(true);
	});

	it("a query against a reaped workspace creates a fresh index rather than reusing the closed one", async () => {
		let spawnCount = 0;
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]), {
			createSymbolIndex: () => {
				spawnCount++;
				return { provenance: TEST_SEMANTIC_PROVENANCE, findSymbols: async () => symbolSearchResult(), close: async () => {} };
			},
		});

		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: process.cwd() });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "anything" });
		expect(spawnCount).toBe(1);

		await sleep(20);
		await service.reapIdleSymbolIndexes(10);

		await service.dispatch("workspace.findSymbols", { workspaceId, query: "anything" });
		expect(spawnCount).toBe(2);
	});
});

describe("daemon's periodic idle-eviction maintenance task", () => {
	it("actually reaps a warm index on its own, on a timer, with no test code calling reapIdleSymbolIndexes directly", async () => {
		// startLectorDaemon doesn't expose a createSymbolIndex override (LectorServiceOptions
		// isn't part of its public surface), so this drives the daemon-kit primitives directly
		// with the exact maintenanceTasks entry daemon.ts's own prepare() wires in -- the same
		// pattern workspace-find-symbols.test.ts already uses for its shutdown-hook test.
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		let closed = false;
		const fakeIndex = {
			provenance: TEST_SEMANTIC_PROVENANCE,
			findSymbols: async () => symbolSearchResult(),
			close: async () => {
				closed = true;
			},
		};

		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]), { createSymbolIndex: () => fakeIndex });
		const token = ensureAuthToken(paths.token, "Lector");
		const app = buildLectorApp(service, token);
		const idleTtlMs = 20;
		const daemon = await startDaemon({
			daemonLabel: "Lector",
			handlePath: paths.handle,
			buildApp: () => app,
			maintenanceTasks: [
				{
					name: "reap-idle-symbol-indexes",
					intervalMs: 15,
					run: async () => {
						await service.reapIdleSymbolIndexes(idleTtlMs);
					},
				},
			],
		});
		cleanup = () => {
			void service.close().then(() => daemon.stop());
			cleanupPaths();
		};

		const client = clientFor(daemon.host, daemon.port, token);
		const { workspaceId } = await client.call("workspace.registerPath", { path: process.cwd() });
		await client.call("workspace.findSymbols", { workspaceId, query: "anything" });
		expect(closed).toBe(false);

		// Long enough for the index to go idle (20ms) and for at least one 15ms-interval
		// sweep to run after that.
		await sleep(80);

		expect(closed).toBe(true);
	}, 5_000);
});
