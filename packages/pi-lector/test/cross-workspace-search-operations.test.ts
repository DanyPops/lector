import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorCrossWorkspaceSearchOperations } from "../extension/src/cross-workspace-search-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

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
});
