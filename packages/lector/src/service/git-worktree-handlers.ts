import { resolve } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { GitPort } from "../git/port.ts";
import { resolveWorktreeMainRoot } from "../git/resolve-worktree-main-root.ts";
import { worktreePathFor } from "../git/worktree-path.ts";
import { LocalFilesystemWorkspace } from "../workspace/local-filesystem-workspace.ts";
import { ReadOnlyWorkspace } from "../workspace/read-only-workspace.ts";
import { deriveWorkspaceId, NotAGitRepository, NotAWorktree, SymbolQueryUnavailable, UnknownWorkspace } from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import type { MutableRegistry } from "./workspace-registry.ts";

export interface GitWorktreeHandlerDeps {
	readonly registry: MutableRegistry;
	readonly createGitPort: (rootPath: string) => GitPort;
	/** Base directory every worktree this daemon creates lives under -- a sibling of GitRepoFetcher's own reposDirectory in production (daemon.ts), an isolated fixture directory in tests. */
	readonly worktreesRoot: string;
	/** workspace.release itself -- reused rather than re-implemented so a worktree workspace is torn down under the exact same active-lease/active-job/active-watch guards as any other, never a parallel, easier-to-drift copy of that logic. */
	readonly releaseWorkspace: (registry: MutableRegistry, input: OperationInputs["workspace.release"]) => Promise<OperationOutputs["workspace.release"]>;
	readonly logger: Logger;
}

export interface GitWorktreeHandlers {
	"workspace.gitWorktreeAdd": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.gitWorktreeAdd"],
	) => Promise<OperationOutputs["workspace.gitWorktreeAdd"]>;
	"workspace.gitWorktreeRemove": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.gitWorktreeRemove"],
	) => Promise<OperationOutputs["workspace.gitWorktreeRemove"]>;
}

/**
 * workspace.gitWorktreeAdd/gitWorktreeRemove -- Tier 2 of Lector's cross-branch verification
 * surface. workspace.gitDiff/showFile answer text/blob-level questions about another ref without
 * a checkout; this tier answers semantic ones (does this symbol exist there, what calls it,
 * where is it declared) by materializing a real, disposable, read-only project at that ref and
 * registering it like any other workspace -- findSymbols/goToDefinition/findReferences/
 * searchText all work against the returned workspaceId unchanged, the same way they already do
 * against a repo.fetch checkout.
 */
export function createGitWorktreeHandlers(deps: GitWorktreeHandlerDeps): GitWorktreeHandlers {
	return {
		async "workspace.gitWorktreeAdd"(_registry, input) {
			const entry = deps.registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
			const sourceRoot = entry.rootPath;
			const git = deps.createGitPort(sourceRoot);
			if (!(await git.isGitRepository())) throw new NotAGitRepository(input.workspaceId);

			const targetDir = resolve(worktreePathFor(deps.worktreesRoot, sourceRoot, input.ref));
			const worktreeWorkspaceId = deriveWorkspaceId(targetDir);

			if (deps.registry.has(worktreeWorkspaceId)) {
				if (!input.forceRefresh) {
					const commit = await git.resolveCommit(input.ref);
					return { workspaceId: worktreeWorkspaceId, path: targetDir, ref: input.ref, commit, created: false };
				}
				// forceRefresh: tear the existing worktree down (same guards as workspace.release --
				// a caller cannot force past a still-in-use worktree) before recreating it.
				await deps.releaseWorkspace(deps.registry, { workspaceId: worktreeWorkspaceId });
				await git.removeWorktree(targetDir);
			}

			const { commit } = await git.addWorktree(input.ref, targetDir);
			deps.registry.set(worktreeWorkspaceId, {
				port: new ReadOnlyWorkspace(new LocalFilesystemWorkspace(targetDir)),
				rootPath: targetDir,
				// A disposable, derived checkout -- never the caller's own primary project -- ranks
				// the same as a repo.fetch checkout for background symbol-graph refresh priority
				// (RegisteredWorkspace.origin's own documented precedent for a foreign checkout with
				// no RepoReference of its own: package-source-handlers.ts's resolved-package
				// checkouts do exactly this).
				origin: "remote",
			});
			deps.logger.info("git worktree created", { component: "git-worktree", operation: "workspace.gitWorktreeAdd" });
			return { workspaceId: worktreeWorkspaceId, path: targetDir, ref: input.ref, commit, created: true };
		},

		async "workspace.gitWorktreeRemove"(_registry, input) {
			const entry = deps.registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
			const mainRoot = await resolveWorktreeMainRoot(entry.rootPath);
			if (!mainRoot) throw new NotAWorktree(input.workspaceId);

			// workspace.release's own guards run first and, on success, remove the registry entry --
			// a WorkspaceReleaseBlocked here leaves the worktree (registry entry and disk state)
			// completely untouched, exactly like calling workspace.release directly would.
			const released = await deps.releaseWorkspace(deps.registry, { workspaceId: input.workspaceId });
			await deps.createGitPort(mainRoot).removeWorktree(entry.rootPath);
			deps.logger.info("git worktree removed", { component: "git-worktree", operation: "workspace.gitWorktreeRemove" });
			return { workspaceId: input.workspaceId, closedIndexes: released.closedIndexes, closedGraph: released.closedGraph, closedWatch: released.closedWatch };
		},
	};
}
