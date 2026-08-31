/** Registry and direct Git entry points must preserve behavior and failure identity. */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { LocalGit } from "../../../src/git/local-git.ts";
import { registerGitOperations } from "../../../src/git/operation-registration.ts";
import { NotAGitRepository } from "../../../src/service/errors.ts";
import { createGitHandlers } from "../../../src/service/git-handlers.ts";
import { createGitWorktreeHandlers } from "../../../src/service/git-worktree-handlers.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";
import { LocalFilesystemWorkspace } from "../../../src/workspace/local-filesystem-workspace.ts";

let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

const READ_PERMISSIONS = ["workspace:read"];

function buildFixture(rootPath: string) {
	const registry: MutableRegistry = new Map([["ws", { port: new LocalFilesystemWorkspace(rootPath), rootPath, origin: "local" as const }]]);
	const logger = { debug() {}, info() {}, warn() {}, error() {} };
	const handlers = createGitHandlers({ registry, createGitPort: (p) => new LocalGit(p), logger });
	const worktreeHandlers = createGitWorktreeHandlers({
		registry,
		createGitPort: (p) => new LocalGit(p),
		worktreesRoot: join(tmpdir(), "lector-git-pilot-worktrees"),
		releaseWorkspace: async (_registry, input) => ({ workspaceId: input.workspaceId, closedIndexes: 0, closedGraph: false, closedWatch: false }),
		logger,
	});
	const vehicleRegistry = new VehicleRegistry({ name: "lector-git-pilot", version: "1.0.0", description: "pilot" });
	registerGitOperations(vehicleRegistry, registry, handlers, worktreeHandlers);
	return { registry, handlers, vehicleRegistry };
}

describe("registerGitOperations", () => {
	it("invoke() matches the direct handler call for a real git repository", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-git-pilot-"));
		git(root, "init", "-q");
		git(root, "config", "user.email", "t@t.com");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, "a.txt"), "hello\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "initial commit");
		writeFileSync(join(root, "a.txt"), "hello again\n");
		const { registry, handlers, vehicleRegistry } = buildFixture(root);

		// invoke() never implicitly trusts a caller -- the granted set has to be passed explicitly.
		const GRANTED = { permissions: READ_PERMISSIONS };

		const directStatus = await handlers["workspace.gitStatus"](registry, { workspaceId: "ws" });
		const vehicleStatus = await vehicleRegistry.invoke("workspace.gitStatus", 1, { workspaceId: "ws" }, GRANTED);
		expect(vehicleStatus).toEqual(directStatus);

		const directLog = await handlers["workspace.gitLog"](registry, { workspaceId: "ws", maxCount: 10 });
		const vehicleLog = await vehicleRegistry.invoke("workspace.gitLog", 1, { workspaceId: "ws", maxCount: 10 }, GRANTED);
		expect(vehicleLog).toEqual(directLog);

		const directDiff = await handlers["workspace.gitDiff"](registry, { workspaceId: "ws", maxBytes: 10_000 });
		const vehicleDiff = await vehicleRegistry.invoke("workspace.gitDiff", 1, { workspaceId: "ws", maxBytes: 10_000 }, GRANTED);
		expect(vehicleDiff).toEqual(directDiff);
	});

	it("exposes bounded full-history grep with direct-handler parity", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-git-history-"));
		git(root, "init", "-q", "--initial-branch=main");
		git(root, "config", "user.email", "t@t.com");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, "a.txt"), "historical needle\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "historical");
		writeFileSync(join(root, "a.txt"), "current value\n");
		git(root, "commit", "-qam", "current");
		const { registry, handlers, vehicleRegistry } = buildFixture(root);
		const input = {
			workspaceId: "ws",
			pattern: "needle",
			commitOffset: 0,
			maxCommits: 20,
			maxMatches: 20,
			maxBytes: 20_000,
			deadlineMs: 5_000,
		};

		const direct = await handlers["workspace.gitGrepHistory"](registry, input);
		const vehicle = await vehicleRegistry.invoke("workspace.gitGrepHistory", 1, input, { permissions: READ_PERMISSIONS });
		expect(vehicle).toEqual(direct);
		expect(direct.matches).toContainEqual(expect.objectContaining({ path: "a.txt", line: 1, text: "historical needle" }));
	});

	it("maps an invalid history-search regex to a validation error", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-git-history-invalid-"));
		git(root, "init", "-q", "--initial-branch=main");
		git(root, "config", "user.email", "t@t.com");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, "a.txt"), "needle\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "initial");
		const { vehicleRegistry } = buildFixture(root);
		const error = await vehicleRegistry
			.invoke(
				"workspace.gitGrepHistory",
				1,
				{
					workspaceId: "ws",
					pattern: "(",
					commitOffset: 0,
					maxCommits: 20,
					maxMatches: 20,
					maxBytes: 20_000,
					deadlineMs: 5_000,
				},
				{ permissions: READ_PERMISSIONS },
			)
			.catch((failure: unknown) => failure);
		expect(isVehicleError(error)).toBe(true);
		expect(error).toMatchObject({ code: "invalid-git-search-pattern", category: "validation" });
	});

	it("a NotAGitRepository failure survives as invoke()'s VehicleError.cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-git-pilot-plain-"));
		const { registry, handlers, vehicleRegistry } = buildFixture(root);

		const directError = await handlers["workspace.gitStatus"](registry, { workspaceId: "ws" }).catch((error: unknown) => error);
		expect(directError).toBeInstanceOf(NotAGitRepository);

		const vehicleError = await vehicleRegistry
			.invoke("workspace.gitStatus", 1, { workspaceId: "ws" }, { permissions: READ_PERMISSIONS })
			.catch((error: unknown) => error);
		expect(isVehicleError(vehicleError)).toBe(true);
		// invoke() throws a VehicleError, not NotAGitRepository directly -- cause carries the original.
		expect((vehicleError as Error).cause).toBeInstanceOf(NotAGitRepository);
		expect(((vehicleError as Error).cause as NotAGitRepository).workspaceId).toBe("ws");
	});
});
