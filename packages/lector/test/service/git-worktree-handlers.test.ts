/**
 * createGitWorktreeHandlers against a real git repository and a real LocalGit -- Tier 2's own
 * vertical slice: workspace.gitWorktreeAdd materializes a real, disposable, read-only project at
 * a ref that every other Lector operation (findSymbols, searchText, ...) can then read like any
 * other registered workspace.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsafeGitArgument } from "../../src/git/assert-safe-git-argument.ts";
import { LocalGit } from "../../src/git/local-git.ts";
import { GitRevisionNotFound } from "../../src/git/revision-not-found.ts";
import { NotAGitRepository, NotAWorktree, UnknownWorkspace, WorkspaceReleaseBlocked } from "../../src/service/errors.ts";
import { createGitWorktreeHandlers, type GitWorktreeHandlers } from "../../src/service/git-worktree-handlers.ts";
import type { MutableRegistry } from "../../src/service/workspace-registry.ts";
import { LocalFilesystemWorkspace } from "../../src/workspace/local-filesystem-workspace.ts";
import { WorkspaceIsReadOnly } from "../../src/workspace/read-only-workspace.ts";

const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

let repoRoot: string | undefined;
let worktreesRoot: string | undefined;

afterEach(() => {
	if (worktreesRoot) rmSync(worktreesRoot, { recursive: true, force: true });
	worktreesRoot = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-worktree-handlers-fixture-"));
	git(root, "init", "-q", "--initial-branch=main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "on main\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "initial commit");
	git(root, "checkout", "-qb", "release-4.20");
	writeFileSync(join(root, "a.txt"), "on release-4.20\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "release-4.20 commit");
	git(root, "checkout", "-q", "main");
	return root;
}

interface Fixture {
	readonly registry: MutableRegistry;
	readonly handlers: GitWorktreeHandlers;
	readonly releaseCalls: string[];
}

function buildFixture(root: string): Fixture {
	worktreesRoot ??= mkdtempSync(join(tmpdir(), "lector-worktree-handlers-root-"));
	const registry: MutableRegistry = new Map([["source", { port: new LocalFilesystemWorkspace(root), rootPath: root, origin: "local" as const }]]);
	const releaseCalls: string[] = [];
	const handlers = createGitWorktreeHandlers({
		registry,
		createGitPort: (p) => new LocalGit(p),
		worktreesRoot,
		releaseWorkspace: async (reg, input) => {
			releaseCalls.push(input.workspaceId);
			if (!reg.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
			reg.delete(input.workspaceId);
			return { workspaceId: input.workspaceId, closedIndexes: 0, closedGraph: false, closedWatch: false };
		},
		logger: NOOP_LOGGER,
	});
	return { registry, handlers, releaseCalls };
}

describe("createGitWorktreeHandlers", () => {
	it("workspace.gitWorktreeAdd registers a new, read-only, checked-out-to-ref workspace", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);

		const result = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });

		expect(result.created).toBe(true);
		expect(result.ref).toBe("release-4.20");
		expect(result.workspaceId).not.toBe("source");
		expect(readFileSync(join(result.path, "a.txt"), "utf8")).toBe("on release-4.20\n");

		const registered = registry.get(result.workspaceId);
		expect(registered?.rootPath).toBe(result.path);
		expect(registered?.origin).toBe("remote");
		await expect(registered?.port.writeEntry("a.txt", null, "nope")).rejects.toBeInstanceOf(WorkspaceIsReadOnly);
	});

	it("reuses an existing worktree for the same (workspace, ref) pair instead of recreating it", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);

		const first = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });
		const second = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });

		expect(second.created).toBe(false);
		expect(second.workspaceId).toBe(first.workspaceId);
		expect(second.path).toBe(first.path);
		expect(second.commit).toBe(first.commit);
	});

	it("reports the worktree's own real checked-out commit on reuse, not the source ref's own current tip, if ref moved since", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);

		const added = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });

		// release-4.20 moves on the SOURCE repo -- this worktree is never told to catch up (no
		// forceRefresh), so it must keep reporting (and serving) its own original commit's content.
		git(repoRoot, "checkout", "-q", "release-4.20");
		writeFileSync(join(repoRoot, "a.txt"), "on release-4.20, moved on without this worktree\n");
		git(repoRoot, "commit", "-qa", "-m", "release-4.20 moves on");
		const movedTip = execFileSync("git", ["rev-parse", "release-4.20"], { cwd: repoRoot }).toString().trim();
		git(repoRoot, "checkout", "-q", "main");

		const reused = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });

		expect(reused.created).toBe(false);
		expect(reused.commit).toBe(added.commit);
		expect(reused.commit).not.toBe(movedTip);
		// The reported commit must actually match what reading from `path` serves -- the whole point.
		expect(readFileSync(join(reused.path, "a.txt"), "utf8")).toBe("on release-4.20\n");
	});

	it("forceRefresh releases and recreates an already-reused worktree", async () => {
		repoRoot = buildRepo();
		const { registry, handlers, releaseCalls } = buildFixture(repoRoot);

		const first = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });
		git(repoRoot, "checkout", "-q", "release-4.20");
		writeFileSync(join(repoRoot, "a.txt"), "on release-4.20, amended\n");
		git(repoRoot, "commit", "-qa", "-m", "amend release-4.20");
		git(repoRoot, "checkout", "-q", "main");

		const refreshed = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20", forceRefresh: true });

		expect(refreshed.created).toBe(true);
		expect(refreshed.workspaceId).toBe(first.workspaceId);
		expect(refreshed.commit).not.toBe(first.commit);
		expect(readFileSync(join(refreshed.path, "a.txt"), "utf8")).toBe("on release-4.20, amended\n");
		expect(releaseCalls).toEqual([first.workspaceId]);
	});

	it("throws UnknownWorkspace for a workspaceId nothing was registered under", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);
		await expect(handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "never-registered", ref: "HEAD" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("throws NotAGitRepository for a real, plain (non-git) workspace", async () => {
		const plainRoot = mkdtempSync(join(tmpdir(), "lector-worktree-handlers-plain-"));
		try {
			const { registry, handlers } = buildFixture(plainRoot);
			await expect(handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "HEAD" })).rejects.toBeInstanceOf(NotAGitRepository);
		} finally {
			rmSync(plainRoot, { recursive: true, force: true });
		}
	});

	it("throws GitRevisionNotFound for a ref that does not resolve", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);
		await expect(handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "no-such-branch" })).rejects.toBeInstanceOf(GitRevisionNotFound);
	});

	it("throws UnsafeGitArgument for a ref that looks like a flag", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);
		await expect(handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "--upload-pack=evil" })).rejects.toBeInstanceOf(
			UnsafeGitArgument,
		);
	});

	it("workspace.gitWorktreeRemove releases the registry entry and deletes the real worktree from disk", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);
		const added = await handlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });

		const removed = await handlers["workspace.gitWorktreeRemove"](registry, { workspaceId: added.workspaceId });

		expect(removed.workspaceId).toBe(added.workspaceId);
		expect(registry.has(added.workspaceId)).toBe(false);
		const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }).toString();
		expect(list).not.toContain(added.path);
	});

	it("workspace.gitWorktreeRemove rejects a workspace that is not a linked worktree", async () => {
		repoRoot = buildRepo();
		const { registry, handlers } = buildFixture(repoRoot);
		await expect(handlers["workspace.gitWorktreeRemove"](registry, { workspaceId: "source" })).rejects.toBeInstanceOf(NotAWorktree);
	});

	it("workspace.gitWorktreeRemove propagates WorkspaceReleaseBlocked without touching the worktree", async () => {
		repoRoot = buildRepo();
		const registry: MutableRegistry = new Map([["source", { port: new LocalFilesystemWorkspace(repoRoot), rootPath: repoRoot, origin: "local" as const }]]);
		worktreesRoot = mkdtempSync(join(tmpdir(), "lector-worktree-handlers-root-"));
		// One shared registry, two handler sets against it: addHandlers can actually release (so
		// the add itself succeeds), removeHandlers always refuses to release (the condition under
		// test).
		const addHandlers = createGitWorktreeHandlers({
			registry,
			createGitPort: (p) => new LocalGit(p),
			worktreesRoot,
			releaseWorkspace: async (reg, input) => {
				reg.delete(input.workspaceId);
				return { workspaceId: input.workspaceId, closedIndexes: 0, closedGraph: false, closedWatch: false };
			},
			logger: NOOP_LOGGER,
		});
		const removeHandlers = createGitWorktreeHandlers({
			registry,
			createGitPort: (p) => new LocalGit(p),
			worktreesRoot,
			releaseWorkspace: async (_reg, input) => {
				throw new WorkspaceReleaseBlocked(input.workspaceId, "active-lease");
			},
			logger: NOOP_LOGGER,
		});
		const added = await addHandlers["workspace.gitWorktreeAdd"](registry, { workspaceId: "source", ref: "release-4.20" });

		await expect(removeHandlers["workspace.gitWorktreeRemove"](registry, { workspaceId: added.workspaceId })).rejects.toBeInstanceOf(WorkspaceReleaseBlocked);
		expect(registry.has(added.workspaceId)).toBe(true);
		const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }).toString();
		expect(list).toContain(added.path);
	});
});
