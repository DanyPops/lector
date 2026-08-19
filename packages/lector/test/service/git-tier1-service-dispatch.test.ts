/**
 * End-to-end through createLectorService.dispatch -- Tier 1's real value proposition:
 * ref-scoped verification (blob content, text search, file listing, ancestry) with no checkout
 * and no registered workspace of its own, unlike Tier 2's workspace.gitWorktreeAdd.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService } from "../../src/service.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(root: string): { main: string; release: string } {
	git(root, "init", "-q", "--initial-branch=main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "holdover.go"), "const LocalHoldoverTimeout = 14400\n");
	git(root, "add", "holdover.go");
	git(root, "commit", "-q", "-m", "initial commit");
	const main = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
	git(root, "checkout", "-qb", "release-4.20");
	writeFileSync(join(root, "holdover.go"), "const LocalHoldoverTimeout = 100\n");
	writeFileSync(join(root, "hardwareconfig.go"), "package hwconfig\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "release-4.20: real holdover envelope + hardwareconfig");
	const release = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
	git(root, "checkout", "-q", "main");
	return { main, release };
}

describe("Tier 1 git operations through createLectorService.dispatch", () => {
	it("gitShowFile/gitGrep/gitListFiles/gitIsAncestor all answer real cross-branch questions with no checkout", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-tier1-dispatch-"));
		let service: LectorService | undefined;
		try {
			const { main, release } = buildRepo(root);
			service = createLectorService(new Map(), { allowDynamicOnly: true });
			const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

			// gitShowFile: a file that doesn't exist on main at all, real content at release-4.20.
			const onMain = await service.dispatch("workspace.gitShowFile", { workspaceId, ref: "main", path: "hardwareconfig.go" });
			expect(onMain.content).toBeUndefined();
			const onRelease = await service.dispatch("workspace.gitShowFile", { workspaceId, ref: "release-4.20", path: "hardwareconfig.go" });
			expect(onRelease.content).toBe("package hwconfig\n");

			// gitGrep: the real, different holdover value at each branch, no checkout involved.
			const grepMain = await service.dispatch("workspace.gitGrep", {
				workspaceId,
				ref: "main",
				pattern: "LocalHoldoverTimeout",
				maxMatches: 10,
				maxBytes: 10_000,
			});
			expect(grepMain.matches).toEqual([{ path: "holdover.go", line: 1, text: "const LocalHoldoverTimeout = 14400" }]);
			const grepRelease = await service.dispatch("workspace.gitGrep", {
				workspaceId,
				ref: "release-4.20",
				pattern: "LocalHoldoverTimeout",
				maxMatches: 10,
				maxBytes: 10_000,
			});
			expect(grepRelease.matches).toEqual([{ path: "holdover.go", line: 1, text: "const LocalHoldoverTimeout = 100" }]);

			// gitListFiles: release-4.20 has a file main never had.
			const filesMain = await service.dispatch("workspace.gitListFiles", { workspaceId, ref: "main", maxResults: 100 });
			expect(filesMain.paths).toEqual(["holdover.go"]);
			const filesRelease = await service.dispatch("workspace.gitListFiles", { workspaceId, ref: "release-4.20", maxResults: 100 });
			expect([...filesRelease.paths].sort()).toEqual(["hardwareconfig.go", "holdover.go"]);

			// gitIsAncestor: the exact "was this commit backported to this branch" question.
			expect((await service.dispatch("workspace.gitIsAncestor", { workspaceId, ancestorRef: main, ref: release })).isAncestor).toBe(true);
			expect((await service.dispatch("workspace.gitIsAncestor", { workspaceId, ancestorRef: release, ref: main })).isAncestor).toBe(false);
		} finally {
			await service?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
