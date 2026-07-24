/**
 * Service-level wiring for the git operations: workspace resolution and
 * NotAGitRepository/UnknownWorkspace error routing. Full LocalGit correctness
 * (real status/log/diff parsing) is already covered directly in
 * test/adapters/local-git.test.ts; this file only proves dispatch is wired.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService, NotAGitRepository, UnknownWorkspace } from "../src/service.ts";

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

describe("createLectorService's git operations", () => {
	it("gitStatus/gitLog/gitDiff reject NotAGitRepository for a plain (non-git) registered workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-git-service-plain-"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await expect(service.dispatch("workspace.gitStatus", { workspaceId })).rejects.toBeInstanceOf(NotAGitRepository);
		await expect(service.dispatch("workspace.gitLog", { workspaceId, maxCount: 10 })).rejects.toBeInstanceOf(NotAGitRepository);
		await expect(service.dispatch("workspace.gitDiff", { workspaceId, maxBytes: 1000 })).rejects.toBeInstanceOf(NotAGitRepository);
	});

	it("rejects an unknown workspaceId before ever touching git", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.gitStatus", { workspaceId: "never-registered" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("routes a real query through the default LocalGit backend end to end", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-git-service-real-"));
		git(root, "init", "-q");
		git(root, "config", "user.email", "t@t.com");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, "a.txt"), "hello\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "initial commit");

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const { entries: logEntries } = await service.dispatch("workspace.gitLog", { workspaceId, maxCount: 10 });
		expect(logEntries.length).toBe(1);
		expect(logEntries[0]?.message).toBe("initial commit");

		writeFileSync(join(root, "a.txt"), "changed\n");
		const statusSummary = await service.dispatch("workspace.gitStatus", { workspaceId });
		expect(statusSummary.files).toContainEqual({ path: "a.txt", indexStatus: " ", workingDirStatus: "M" });

		const diffResult = await service.dispatch("workspace.gitDiff", { workspaceId, maxBytes: 10_000 });
		expect(diffResult.diff).toContain("+changed");
	});
});
