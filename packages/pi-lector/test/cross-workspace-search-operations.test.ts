import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		for (const outcome of results) {
			expect(outcome.status).toBe("ready");
			if (outcome.status === "ready") expect(outcome.result.matches.length).toBeGreaterThan(0);
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
});
