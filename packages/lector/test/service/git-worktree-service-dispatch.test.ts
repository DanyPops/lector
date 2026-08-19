/**
 * End-to-end through createLectorService's own dispatch -- the real value proposition of Tier 2:
 * workspace.gitWorktreeAdd hands back a workspaceId that every other real Lector operation
 * (proven here with workspace.rawRead and workspace.searchText) can read against, unmodified,
 * even though it was never registered via workspace.registerPath.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { createLectorService, type LectorService } from "../../src/service.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(root: string): void {
	git(root, "init", "-q", "--initial-branch=main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "holdover.go"), "const LocalHoldoverTimeout = 14400\n");
	git(root, "add", "holdover.go");
	git(root, "commit", "-q", "-m", "initial commit");
	git(root, "checkout", "-qb", "release-4.20");
	writeFileSync(join(root, "holdover.go"), "const LocalHoldoverTimeout = 100\n");
	git(root, "add", "holdover.go");
	git(root, "commit", "-q", "-m", "release-4.20: real holdover envelope");
	git(root, "checkout", "-q", "main");
}

describe("workspace.gitWorktreeAdd/gitWorktreeRemove through createLectorService.dispatch", () => {
	it("reads a real, different file at another branch through the same operations as the main workspace, then tears it down cleanly", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-worktree-dispatch-"));
		const worktreesRoot = mkdtempSync(join(tmpdir(), "lector-worktree-dispatch-root-"));
		buildRepo(root);
		let service: LectorService | undefined;
		try {
			service = createLectorService(new Map(), { allowDynamicOnly: true, worktreesRoot });
			const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

			const onMain = await service.dispatch("workspace.rawRead", { workspaceId, path: "holdover.go" });
			expect(onMain.content).toContain("LocalHoldoverTimeout = 14400");

			const added = await service.dispatch("workspace.gitWorktreeAdd", { workspaceId, ref: "release-4.20" });
			expect(added.created).toBe(true);
			expect(added.workspaceId).not.toBe(workspaceId);

			// workspace.rawRead against the worktree's own workspaceId -- no different code path,
			// no special-casing, exactly the same operation the main workspace used above.
			const onBranch = await service.dispatch("workspace.rawRead", { workspaceId: added.workspaceId, path: "holdover.go" });
			expect(onBranch.content).toContain("LocalHoldoverTimeout = 100");

			// workspace.searchText (real ripgrep) also works against it unmodified.
			const searched = await service.dispatch("workspace.searchText", {
				workspaceId: added.workspaceId,
				query: "LocalHoldoverTimeout",
				maxMatches: 10,
				maxBytes: 10_000,
			});
			expect(searched.matches.length).toBeGreaterThan(0);

			// The worktree is genuinely read-only -- a write must fail, unlike the main workspace.
			const writeAttempt = await service
				.dispatch("workspace.exactEdit", { workspaceId: added.workspaceId, path: "holdover.go", expectedHash: null, content: "nope" })
				.catch((error: unknown) => error);
			expect(isVehicleError(writeAttempt) || writeAttempt instanceof Error).toBe(true);

			const removed = await service.dispatch("workspace.gitWorktreeRemove", { workspaceId: added.workspaceId });
			expect(removed.workspaceId).toBe(added.workspaceId);

			// Gone from the registry -- a further read against it fails like any other unknown workspace.
			const afterRemoval = await service
				.dispatch("workspace.rawRead", { workspaceId: added.workspaceId, path: "holdover.go" })
				.catch((error: unknown) => error);
			expect(isVehicleError(afterRemoval) || afterRemoval instanceof Error).toBe(true);
		} finally {
			await service?.close();
			rmSync(root, { recursive: true, force: true });
			rmSync(worktreesRoot, { recursive: true, force: true });
		}
	});
});
