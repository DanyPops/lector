/**
 * Walking-skeleton step 5's "one symbol query" (lector-generic-capability-design-kkje),
 * wired as workspace.findSymbols. Exercised through the real daemon over
 * HTTP, against Lector's own source (dogfood), with a real
 * typescript-language-server kept warm across calls.
 */
import { startDaemon } from "@danypops/daemon-kit/daemon";
import { ensureAuthToken, readDaemonHandle } from "@danypops/daemon-kit/paths";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { TypescriptSymbolIndex } from "../src/adapters/lsp/typescript-symbol-index.ts";
import { buildLectorApp, startLectorDaemon } from "../src/daemon.ts";
import { createLectorService, type LectorServiceOptions, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

const LECTOR_ROOT = new URL("..", import.meta.url).pathname;

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function clientFor(host: string, port: number, token: string) {
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${host}:${port}`, token, {
		label: "Lector",
	});
}

describe("workspace.findSymbols", () => {
	it("requires a workspace registered via workspace.registerPath, not a statically-declared one", async () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const daemon = startLectorDaemon({ workspaces: new Map([["static", new InMemoryWorkspace()]]), paths });
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};
		const token = readFileSync(paths.token, "utf8").trim();
		const client = clientFor(daemon.host, daemon.port, token);

		let caught: unknown;
		try {
			await client.call("workspace.findSymbols", { workspaceId: "static", seedFile: "src/index.ts", query: "x" });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("SymbolQueryUnavailable");
	});

	it(
		"finds a real symbol in Lector's own source, and reuses one warm index across repeat calls",
		async () => {
			const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
			let spawnCount = 0;
			const options: LectorServiceOptions = {
				createSymbolIndex: (rootPath, seedFile) => {
					spawnCount++;
					return new TypescriptSymbolIndex(rootPath, seedFile);
				},
			};

			const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]), options);
			const token = ensureAuthToken(paths.token, "Lector");
			const app = buildLectorApp(service, token);
			const daemon = startDaemon({ daemonLabel: "Lector", handlePath: paths.handle, buildApp: () => app });
			cleanup = () => {
				void service.close().then(() => daemon.stop());
				cleanupPaths();
			};

			const client = clientFor(daemon.host, daemon.port, token);
			const { workspaceId } = await client.call("workspace.registerPath", { path: LECTOR_ROOT });

			const first = await client.call("workspace.findSymbols", { workspaceId, seedFile: "src/index.ts", query: "exactEdit" });
			const second = await client.call("workspace.findSymbols", { workspaceId, seedFile: "src/index.ts", query: "rawRead" });

			expect(first.symbols.some((symbol) => symbol.name === "exactEdit")).toBe(true);
			expect(second.symbols.some((symbol) => symbol.name === "rawRead")).toBe(true);
			expect(spawnCount).toBe(1); // one warm index served both queries
		},
		20_000,
	);

	it(
		"finds a real symbol with no seedFile given at all, via bounded auto-discovery",
		async () => {
			const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
			const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));
			const token = ensureAuthToken(paths.token, "Lector");
			const app = buildLectorApp(service, token);
			const daemon = startDaemon({ daemonLabel: "Lector", handlePath: paths.handle, buildApp: () => app });
			cleanup = () => {
				void service.close().then(() => daemon.stop());
				cleanupPaths();
			};

			const client = clientFor(daemon.host, daemon.port, token);
			const { workspaceId } = await client.call("workspace.registerPath", { path: LECTOR_ROOT });

			// No seedFile in the input at all -- discoverSeedFile() must find one on its own
			// (Lector's own src/index.ts barrel, via the common-candidate list).
			const { symbols } = await client.call("workspace.findSymbols", { workspaceId, query: "exactEdit" });

			expect(symbols.some((symbol) => symbol.name === "exactEdit")).toBe(true);
		},
		20_000,
	);

	it("the daemon's shutdown hook actually closes every warm symbol index it created (not just the handle file)", async () => {
		// LanguageServerProcess.stop()'s own OS-level kill correctness is already proven by
		// the evil-server tests -- this test verifies a different thing: that the service and
		// daemon actually *wire up and call* close() on shutdown, using a fake index so a
		// missing/broken wiring fails deterministically instead of depending on process timing.
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		let closed = false;
		const fakeIndex = {
			findSymbols: async () => [],
			close: async () => {
				closed = true;
			},
		};

		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]), {
			createSymbolIndex: () => fakeIndex,
		});
		const token = ensureAuthToken(paths.token, "Lector");
		const app = buildLectorApp(service, token);
		const daemon = startDaemon({
			daemonLabel: "Lector",
			handlePath: paths.handle,
			buildApp: () => app,
			onShutdown: () => service.close(),
		});
		cleanup = cleanupPaths;

		const client = clientFor(daemon.host, daemon.port, token);
		const { workspaceId } = await client.call("workspace.registerPath", { path: LECTOR_ROOT });
		await client.call("workspace.findSymbols", { workspaceId, seedFile: "src/index.ts", query: "exactEdit" });

		expect(closed).toBe(false);
		await daemon.stop();
		expect(closed).toBe(true);
		expect(readDaemonHandle(paths.handle)).toBeNull();
	});
});
