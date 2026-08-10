/**
 * Real end-to-end proof of the live stress finding: adding a `[lib] path` to a Cargo.toml
 * that previously had none, mid-session, left a warm rust-analyzer serving its pre-change
 * crate graph indefinitely -- confirmed live that this is not merely a missed
 * workspace/didChangeWatchedFiles notification (that pipeline is proven correct in
 * notify-file-changed.test.ts) but a genuine rust-analyzer limitation: a fresh process
 * against the identical, already-changed Cargo.toml sees the new target immediately, a live
 * one does not. WarmIndexRegistry.closeForRootMarkerChange force-closes the affected
 * language's own warm index on a real root-marker (Cargo.toml) change, so the next query
 * transparently pays a fresh-spawn cost instead of returning stale results forever.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-rust-manifest-change-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
	writeFileSync(join(root, "src", "main.rs"), 'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn main() {\n    println!("{}", add(1, 2));\n}\n');
	git(root, "init", "-q");
	git(root, "add", "-A");
	git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init");
	return root;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a real project-manifest change restarts only the affected warm index", () => {
	it("picks up a new [lib] target added to Cargo.toml mid-session, instead of serving a stale crate graph forever", async () => {
		fixtureRoot = buildFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		// Warms rust-analyzer and (being a real git repo) arms the OS watcher.
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const before = await service.dispatch("workspace.findSymbols", { workspaceId, query: "normalizeLib", maxResults: 10 });
		expect(before.symbols.map((symbol) => symbol.name)).not.toContain("normalizeLib");

		writeFileSync(join(fixtureRoot, "src", "newlib.rs"), "pub fn normalizeLib(x: i32) -> i32 {\n    x\n}\n");
		writeFileSync(join(fixtureRoot, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/newlib.rs"\n');

		// Poll rather than a fixed sleep: a fresh rust-analyzer spawn's own cold-start time is
		// real, external latency, not something this test should hardcode.
		const deadline = Date.now() + 30_000;
		let found = false;
		while (Date.now() < deadline && !found) {
			await sleep(500);
			const after = await service.dispatch("workspace.findSymbols", { workspaceId, query: "normalizeLib", maxResults: 10 });
			found = after.symbols.map((symbol) => symbol.name).includes("normalizeLib");
		}

		expect(found).toBe(true);
	}, 60_000);
});
