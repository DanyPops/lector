/**
 * Vehicle migration Phase 1 pilot proof: registerGitVehicleOperations's VehicleRegistry.invoke()
 * path must produce the exact same result as calling the underlying GitHandlers function directly,
 * for both the success path and the real NotAGitRepository error path -- proving the wrapper adds a
 * second entry point over identical business logic rather than forking it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { LocalGit } from "../../../src/git/local-git.ts";
import { NotAGitRepository } from "../../../src/service/errors.ts";
import { createGitHandlers } from "../../../src/service/git-handlers.ts";
import { registerGitVehicleOperations } from "../../../src/service/vehicle/git-operations.ts";
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
	const handlers = createGitHandlers({ registry, createGitPort: (p) => new LocalGit(p), logger: { debug() {}, info() {}, warn() {}, error() {} } });
	const vehicleRegistry = new VehicleRegistry({ name: "lector-git-pilot", version: "1.0.0", description: "pilot" });
	registerGitVehicleOperations(vehicleRegistry, registry, handlers);
	return { registry, handlers, vehicleRegistry };
}

describe("Vehicle migration pilot: workspace.gitStatus/gitLog/gitDiff", () => {
	it("VehicleRegistry.invoke() returns the exact same result as calling GitHandlers directly, for a real git repository", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-git-pilot-"));
		git(root, "init", "-q");
		git(root, "config", "user.email", "t@t.com");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, "a.txt"), "hello\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "initial commit");
		writeFileSync(join(root, "a.txt"), "hello again\n");
		const { registry, handlers, vehicleRegistry } = buildFixture(root);

		// invoke() enforces each operation's declared permissions for real -- it never implicitly
		// trusts a caller, so the granted set has to be passed explicitly on every call, the same
		// way a real authenticated principal's own granted scopes would be.
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

	it("preserves the real NotAGitRepository failure through VehicleError.cause, for a plain (non-git) workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-git-pilot-plain-"));
		const { registry, handlers, vehicleRegistry } = buildFixture(root);

		const directError = await handlers["workspace.gitStatus"](registry, { workspaceId: "ws" }).catch((error: unknown) => error);
		expect(directError).toBeInstanceOf(NotAGitRepository);

		const vehicleError = await vehicleRegistry
			.invoke("workspace.gitStatus", 1, { workspaceId: "ws" }, { permissions: READ_PERMISSIONS })
			.catch((error: unknown) => error);
		expect(isVehicleError(vehicleError)).toBe(true);
		// The original typed domain error survives at the Vehicle boundary only via Error.cause --
		// the thrown value's own type is VehicleError, not NotAGitRepository. Real friction for
		// Phase 3: every instanceof-checking consumer needs a mapped VehicleFailureDescriptor instead.
		expect((vehicleError as Error).cause).toBeInstanceOf(NotAGitRepository);
		expect(((vehicleError as Error).cause as NotAGitRepository).workspaceId).toBe("ws");
	});
});
