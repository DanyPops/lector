/**
 * Service-level wiring for the git-based cache-freshness fast path:
 * workspace.cacheStatus can prove a symbol graph is still fresh via git
 * (clean tree, unchanged HEAD) without paying for a full source rehash.
 * Every case here also proves correctness of the *answer* (not just that
 * it was fast) -- the dedicated performance comparison lives in
 * test/performance/git-cache-freshness.perf.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildGitFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-git-cache-freshness-"));
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@t.com");
	git(dir, "config", "user.name", "t");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "initial");
	return dir;
}

describe("createLectorService's git-based cache-freshness fast path", () => {
	it("reports cached via the fast path when the tree is clean and HEAD is unchanged since population", async () => {
		root = buildGitFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const populated = await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(populated.completeness).toBe("complete");

		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(status.status).toBe("cached");
	});

	it("falls back to the full check (and still answers correctly) when the tree is dirty", async () => {
		root = buildGitFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		writeFileSync(join(root, "a.ts"), "export const a = 2;\n"); // uncommitted change -- dirty tree
		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(status.status).toBe("not-cached");
		expect(status.status === "not-cached" && status.reason).toBe("source-changed");
	});

	it("falls back to the full check (and still answers correctly) when HEAD has moved since population", async () => {
		root = buildGitFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "second"); // tree is clean again, but HEAD moved

		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(status.status).toBe("not-cached");
		expect(status.status === "not-cached" && status.reason).toBe("source-changed");
	});

	it("still works correctly for a non-git workspace -- the fast path is simply never eligible", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-git-cache-freshness-plain-"));
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(status.status).toBe("cached");
	});

	it("does not record a git sha (and so never takes the fast path) when the tree was already dirty at population time", async () => {
		root = buildGitFixture();
		writeFileSync(join(root, "a.ts"), "export const a = 999;\n"); // dirty before the very first population
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		// Still dirty in the exact same way -- a full rehash would correctly say "cached" (source
		// unchanged since population even though uncommitted), proving the answer stays correct
		// even though no git sha could ever have been recorded to fast-path this check.
		const status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(status.status).toBe("cached");
	});
});
