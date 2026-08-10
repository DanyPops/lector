/**
 * workspace.resolvePath is the single server-side choke point every former pi-lector client-side
 * resolver (workspaceForPath, workspaceForDirectory, workspaceForCodeIntelligencePath,
 * workspaceForProjectDirectory, workspaceForPathOrDirectory) now calls instead of reimplementing
 * its own filesystem walk-up. This proves it end to end through a real createLectorService,
 * including actual workspace registration -- resolveWorkspacePath's own unit tests already cover
 * every strategy/fallback combination in isolation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

describe("workspace.resolvePath", () => {
	it("resolves and registers a real git root, returning the same workspaceId workspace.registerPath itself would for that exact root", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-"));
		mkdirSync(join(fixtureRoot, ".git"));
		const deep = join(fixtureRoot, "src", "lib");
		mkdirSync(deep, { recursive: true });
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const resolved = await service.dispatch("workspace.resolvePath", { strategy: "git-root", path: deep, fallback: "given-directory" });
		expect(resolved).toMatchObject({ found: true, root: fixtureRoot, created: true });

		const direct = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		expect(resolved).toMatchObject({ workspaceId: direct.workspaceId });
	});

	it("does not re-create an already-registered workspace on a second resolution of the same root", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-idempotent-"));
		mkdirSync(join(fixtureRoot, ".git"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const first = await service.dispatch("workspace.resolvePath", { strategy: "git-root", path: fixtureRoot, fallback: "given-directory" });
		const second = await service.dispatch("workspace.resolvePath", { strategy: "git-root", path: fixtureRoot, fallback: "given-directory" });
		expect(first).toMatchObject({ found: true, created: true });
		expect(second).toMatchObject({ found: true, created: false });
		if (first.found && second.found) expect(first.workspaceId).toBe(second.workspaceId);
	});

	it("falls back to the filesystem root and registers it, for the raw read/write/edit contract", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-fsroot-"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const resolved = await service.dispatch("workspace.resolvePath", { strategy: "git-root", path: fixtureRoot, fallback: "filesystem-root" });
		expect(resolved).toMatchObject({ found: true, root: parse(fixtureRoot).root });
	});

	it("resolves a monorepo subproject to itself via language-project-root, not the outer repo", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-monorepo-"));
		mkdirSync(join(fixtureRoot, ".git"));
		const subproject = join(fixtureRoot, "packages", "app");
		mkdirSync(subproject, { recursive: true });
		writeFileSync(join(subproject, "tsconfig.json"), "{}");
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const resolved = await service.dispatch("workspace.resolvePath", {
			strategy: "language-project-root",
			path: subproject,
			fallback: "given-directory",
			extension: ".ts",
		});
		expect(resolved).toMatchObject({ found: true, root: subproject });
	});

	it("reports found: false for declared-monorepo-root against a plain single-package repo, without registering anything", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-declared-none-"));
		writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ name: "solo" }));
		const projectRoot = join(fixtureRoot, "src");
		mkdirSync(projectRoot);
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const resolved = await service.dispatch("workspace.resolvePath", { strategy: "declared-monorepo-root", path: projectRoot });
		expect(resolved).toEqual({ found: false });
	});

	it("finds a declared monorepo root and registers it", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-declared-found-"));
		writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ name: "repo", workspaces: ["packages/*"] }));
		const projectRoot = join(fixtureRoot, "packages", "library");
		mkdirSync(projectRoot, { recursive: true });
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const resolved = await service.dispatch("workspace.resolvePath", { strategy: "declared-monorepo-root", path: projectRoot });
		expect(resolved).toMatchObject({ found: true, root: fixtureRoot });
	});

	it("treats an already-real directory as the resolution start for path-or-directory, not its dirname -- the real, previously-shipped bug this fixes", async () => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "lector-resolve-path-or-dir-"));
		mkdirSync(join(fixtureRoot, ".git"));
		const nested = join(fixtureRoot, "packages", "app");
		mkdirSync(nested, { recursive: true });
		mkdirSync(join(nested, ".git"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });

		const resolved = await service.dispatch("workspace.resolvePath", { strategy: "path-or-directory", path: nested });
		expect(resolved).toMatchObject({ found: true, root: nested });
	});

	it("rejects a relative path outright -- a daemon has no caller-relative cwd of its own", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.resolvePath", { strategy: "git-root", path: "relative/path", fallback: "given-directory" })).rejects.toThrow();
	});
});
