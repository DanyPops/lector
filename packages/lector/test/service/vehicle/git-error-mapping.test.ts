/**
 * mapGitError must code/categorize each of requireGitRepository's domain errors, preserve the
 * original as cause, and declare the same codes on each operation's descriptor for manifest().
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { LocalGit } from "../../../src/git/local-git.ts";
import { NotAGitRepository, UnknownWorkspace } from "../../../src/service/errors.ts";
import { createGitHandlers } from "../../../src/service/git-handlers.ts";
import { registerGitVehicleOperations } from "../../../src/service/vehicle/git-operations.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";
import { LocalFilesystemWorkspace } from "../../../src/workspace/local-filesystem-workspace.ts";

const READ_PERMISSIONS = ["workspace:read"];
let root: string | undefined;

function buildFixture(rootPath: string) {
	const registry: MutableRegistry = new Map([["ws", { port: new LocalFilesystemWorkspace(rootPath), rootPath, origin: "local" as const }]]);
	const handlers = createGitHandlers({ registry, createGitPort: (p) => new LocalGit(p), logger: { debug() {}, info() {}, warn() {}, error() {} } });
	const vehicleRegistry = new VehicleRegistry({ name: "lector-git-error-mapping", version: "1.0.0", description: "test" });
	registerGitVehicleOperations(vehicleRegistry, registry, handlers);
	return vehicleRegistry;
}

async function invokeAndCatch(vehicleRegistry: VehicleRegistry, input: Record<string, unknown>): Promise<VehicleError> {
	const error = await vehicleRegistry.invoke("workspace.gitStatus", 1, input, { permissions: READ_PERMISSIONS }).catch((caught: unknown) => caught);
	if (!isVehicleError(error)) throw new Error(`expected a VehicleError, got ${String(error)}`);
	return error;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("git operation error mapping", () => {
	it("maps NotAGitRepository to a coded VehicleError, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-error-mapping-plain-"));
		const vehicleRegistry = buildFixture(root);

		const error = await invokeAndCatch(vehicleRegistry, { workspaceId: "ws" });
		expect(error.code).toBe("not-a-git-repository");
		expect(error.category).toBe("validation");
		expect(error.cause).toBeInstanceOf(NotAGitRepository);
	});

	it("maps UnknownWorkspace to a coded VehicleError, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-error-mapping-unknown-"));
		const vehicleRegistry = buildFixture(root);

		const error = await invokeAndCatch(vehicleRegistry, { workspaceId: "never-registered" });
		expect(error.code).toBe("unknown-workspace");
		expect(error.category).toBe("not_found");
		expect(error.cause).toBeInstanceOf(UnknownWorkspace);
	});

	it("declares the same 3 error codes on every migrated operation, via manifest()", () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-error-mapping-manifest-"));
		const vehicleRegistry = buildFixture(root);

		const manifest = vehicleRegistry.manifest();
		const codes = ["unknown-workspace", "symbol-query-unavailable", "not-a-git-repository"];
		for (const name of ["workspace.gitStatus", "workspace.gitLog", "workspace.gitDiff"]) {
			const operation = manifest.operations.find((candidate) => candidate.name === name);
			expect(operation).toBeDefined();
			expect(operation?.errors.map((failure) => failure.code).sort()).toEqual([...codes].sort());
		}
	});
});
