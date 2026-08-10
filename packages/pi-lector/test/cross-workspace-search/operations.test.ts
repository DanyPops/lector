import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LectorClient, OperationInputs, OperationName, OperationOutputs } from "@danypops/lector";
import { createLectorCrossWorkspaceSearchOperations } from "../../extension/src/cross-workspace-search/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

/**
 * A fully scripted, in-process LectorClient -- no real daemon -- so a test can dictate the exact
 * (potentially malformed/reordered) shape a real daemon's own bug could produce, in total
 * isolation from that bug itself. workspace.registerPath returns a deterministic id per
 * directory (its own path, prefixed) so a test can predict exactly what workspaceIds ends up
 * sent to search.symbols/search.text.
 */
function scriptedClient(handlers: Partial<Record<OperationName, (input: never) => unknown>>): LectorClient {
	return {
		async call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			const handler = handlers[operation];
			if (handler) return handler(input as never) as OperationOutputs[Name];
			if (operation === "workspace.registerPath") {
				const { path } = input as OperationInputs["workspace.registerPath"];
				return { workspaceId: `ws-${path}`, created: true } as OperationOutputs[Name];
			}
			throw new Error(`scriptedClient: no handler for ${operation}`);
		},
		operations: async () => [],
		ready: async () => true,
		health: async () => ({ ok: true, version: "test" }),
	};
}

let dirs: string[] = [];
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function buildDir(fileName: string, content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-lector-cross-search-"));
	writeFileSync(join(dir, fileName), content);
	dirs.push(dir);
	return dir;
}

/**
 * A monorepo shape: one outer git root, two sibling packages each with their own package.json
 * (a real TypeScript project-root marker) -- the exact shape that collapsed into one workspaceId
 * before this fix, since both siblings share the same nearest .git.
 */
function buildMonorepo(): { packageA: string; packageB: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-cross-search-monorepo-"));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	const packageA = join(root, "packages", "a");
	const packageB = join(root, "packages", "b");
	mkdirSync(packageA, { recursive: true });
	mkdirSync(packageB, { recursive: true });
	writeFileSync(join(packageA, "package.json"), "{}");
	writeFileSync(join(packageA, "a.txt"), "hello from a\n");
	writeFileSync(join(packageB, "package.json"), "{}");
	writeFileSync(join(packageB, "b.txt"), "hello from b\n");
	return { packageA, packageB };
}

/**
 * Two subdirectories under one outer git root, NEITHER carrying its own project-root marker --
 * a genuine case where both really do belong to the same workspace, distinct from the monorepo
 * case above. The fix must still surface this collision explicitly rather than pretending the
 * two inputs were independent.
 */
function buildUnmarkedSiblings(): { dirA: string; dirB: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-cross-search-unmarked-"));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	const dirA = join(root, "src", "a");
	const dirB = join(root, "src", "b");
	mkdirSync(dirA, { recursive: true });
	mkdirSync(dirB, { recursive: true });
	writeFileSync(join(dirA, "a.txt"), "hello from a\n");
	writeFileSync(join(dirB, "b.txt"), "hello from b\n");
	return { dirA, dirB };
}

describe("Lector-backed cross-workspace search operations", () => {
	it("threads maxResults through to search.symbols when given, and omits it entirely otherwise", async () => {
		const recordedInputs: OperationInputs["search.symbols"][] = [];
		const client = scriptedClient({
			"search.symbols": (input: OperationInputs["search.symbols"]) => {
				recordedInputs.push(input);
				return { results: input.workspaceIds?.map((workspaceId) => ({ workspaceId, status: "ready", result: { symbols: [], truncated: false } })) ?? [] };
			},
		});
		setLectorClientConnectorForTests(() => Promise.resolve(client));
		const dirA = buildDir("a.txt", "hello\n");

		const ops = createLectorCrossWorkspaceSearchOperations();
		await ops.findSymbols("found", [dirA], undefined, 7);
		await ops.findSymbols("found", [dirA]);

		expect(recordedInputs[0]?.maxResults).toBe(7);
		expect(recordedInputs[1]).not.toHaveProperty("maxResults");
	});

	it("searchText finds real matches independently in each explicitly-named directory", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const dirA = buildDir("a.txt", "hello world\n");
		const dirB = buildDir("b.txt", "hello again\n");

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [dirA, dirB], 100, 10_000);

		expect(results.length).toBe(2);
		for (const entry of results) {
			expect(entry.outcome.status).toBe("ready");
			if (entry.outcome.status === "ready") expect(entry.outcome.result.matches.length).toBeGreaterThan(0);
		}
	}, 20_000);

	it("only searches the explicitly-named directories, isolated from the daemon's own bootstrap workspace", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const dirA = buildDir("a.txt", "hello world\n");

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [dirA], 100, 10_000);

		// Exactly one outcome -- the bootstrap in-memory workspace startIsolatedLectorDaemon
		// always registers is never included just because it happens to exist in the registry.
		expect(results.length).toBe(1);
	}, 20_000);

	it("resolves two sibling monorepo packages (each with their own package.json) to distinct workspaces, not a collapsed shared one", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { packageA, packageB } = buildMonorepo();

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [packageA, packageB], 100, 10_000);

		expect(results.length).toBe(2);
		expect(results[0]?.workspaceId).not.toBe(results[1]?.workspaceId);
		for (const entry of results) expect(entry.collapsedWith).toEqual([]);
		// Each package's own real match, not the other package's, or a duplicate of one payload.
		const matched = results.map((entry) => (entry.outcome.status === "ready" ? entry.outcome.result.matches.map((m) => m.path) : []));
		expect(matched[0]).toEqual(["a.txt"]);
		expect(matched[1]).toEqual(["b.txt"]);
	}, 20_000);

	it("surfaces a genuine collision explicitly via collapsedWith when two inputs really do share one workspace", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { dirA, dirB } = buildUnmarkedSiblings();

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [dirA, dirB], 100, 10_000);

		expect(results.length).toBe(2);
		expect(results[0]?.workspaceId).toBe(results[1]?.workspaceId);
		expect(results[0]?.collapsedWith).toEqual([dirB]);
		expect(results[1]?.collapsedWith).toEqual([dirA]);
	}, 20_000);

	it("correlates by workspaceId, not array position -- a daemon response reordered relative to the request must not mislabel results under different directories", async () => {
		const dirA = buildDir("a.txt", "hello from a\n");
		const dirB = buildDir("b.txt", "hello from b\n");
		const idA = `ws-${dirA}`;
		const idB = `ws-${dirB}`;
		// Exactly the real server bug this reproduces: an immediate per-entry error prepended
		// ahead of the real ready results, scrambling response order relative to the request's
		// workspaceIds -- proven separately and directly at packages/lector/test/
		// service-cross-workspace-search.test.ts.
		setLectorClientConnectorForTests(() =>
			Promise.resolve(
				scriptedClient({
					"search.text": async () => ({
						results: [
							{ workspaceId: idB, status: "ready", result: { matches: [{ path: "b.txt", line: 1, text: "hello from b" }], truncated: false } },
							{ workspaceId: idA, status: "ready", result: { matches: [{ path: "a.txt", line: 1, text: "hello from a" }], truncated: false } },
						],
					}),
				}),
			),
		);

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [dirA, dirB], 100, 10_000);

		const byDirectory = new Map(results.map((entry) => [entry.directory, entry]));
		const forA = byDirectory.get(dirA);
		const forB = byDirectory.get(dirB);
		expect(forA?.workspaceId).toBe(idA);
		expect(forB?.workspaceId).toBe(idB);
		expect(forA?.outcome.status === "ready" ? forA.outcome.result.matches[0]?.path : undefined).toBe("a.txt");
		expect(forB?.outcome.status === "ready" ? forB.outcome.result.matches[0]?.path : undefined).toBe("b.txt");
	});

	it("throws rather than silently mislabeling when the daemon returns an outcome for a workspaceId nobody asked for", async () => {
		const dirA = buildDir("a.txt", "hello from a\n");
		setLectorClientConnectorForTests(() =>
			Promise.resolve(
				scriptedClient({
					"search.text": async () => ({
						results: [{ workspaceId: "totally-unrelated-workspace", status: "ready", result: { matches: [], truncated: false } }],
					}),
				}),
			),
		);

		const ops = createLectorCrossWorkspaceSearchOperations();

		await expect(ops.searchText("hello", [dirA], 100, 10_000)).rejects.toThrow();
	});

	it("re-registers a workspace the daemon forgot (a real daemon restart wipes its in-memory registry) and retries once, transparently", async () => {
		const dirA = buildDir("a.txt", "hello from a\n");
		let registerCalls = 0;
		let searchCalls = 0;
		setLectorClientConnectorForTests(() =>
			Promise.resolve(
				scriptedClient({
					"workspace.registerPath": async (input) => {
						registerCalls++;
						return { workspaceId: `ws-${(input as { path: string }).path}`, created: true };
					},
					"search.text": async (input) => {
						searchCalls++;
						const { workspaceIds } = input as { workspaceIds: readonly string[] };
						const workspaceId = workspaceIds[0] as string;
						if (searchCalls === 1) {
							// A fresh daemon (restarted since this workspaceId was cached) has no record of it.
							return { results: [{ workspaceId, status: "error", message: `no workspace registered under id "${workspaceId}"` }] };
						}
						return { results: [{ workspaceId, status: "ready", result: { matches: [{ path: "a.txt", line: 1, text: "hello from a" }], truncated: false } }] };
					},
				}),
			),
		);

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [dirA], 100, 10_000);

		expect(searchCalls).toBe(2); // one failed attempt, one retry -- never silently stuck on the stale error forever
		expect(registerCalls).toBe(2); // re-registered once after dropping the stale cached id
		expect(results[0]?.outcome.status).toBe("ready");
	});

	it("does not retry a genuine per-workspace error that has nothing to do with a stale registration", async () => {
		const dirA = buildDir("a.txt", "hello from a\n");
		let searchCalls = 0;
		setLectorClientConnectorForTests(() =>
			Promise.resolve(
				scriptedClient({
					"search.text": async (input) => {
						searchCalls++;
						const { workspaceIds } = input as { workspaceIds: readonly string[] };
						return { results: [{ workspaceId: workspaceIds[0] as string, status: "error", message: "ripgrep is not installed" }] };
					},
				}),
			),
		);

		const ops = createLectorCrossWorkspaceSearchOperations();
		const results = await ops.searchText("hello", [dirA], 100, 10_000);

		expect(searchCalls).toBe(1); // no pointless retry for an error unrelated to workspace identity
		expect(results[0]?.outcome.status).toBe("error");
	});
});
