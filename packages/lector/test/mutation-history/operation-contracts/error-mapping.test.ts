/**
 * mapMutationHistoryError must code/categorize each of MutationHistoryHandlers' domain errors,
 * preserve the original as cause, and declare the same codes on each operation's descriptor for
 * manifest().
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { ContentHash } from "../../../src/content-identity/content-hash.ts";
import { contentHashOf } from "../../../src/content-identity/content-hash.ts";
import { InMemoryMutationHistory } from "../../../src/mutation-history/in-memory-mutation-history.ts";
import { registerMutationHistoryOperations } from "../../../src/mutation-history/operation-registration.ts";
import { MutationEntryNotFound, MutationRevertStale, UnknownWorkspace } from "../../../src/service/errors.ts";
import { MutationHistoryCoordinator } from "../../../src/service/mutation-history-handlers.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";
import { StaleExpectedHash } from "../../../src/workspace/exact-edit.ts";
import { LocalFilesystemWorkspace } from "../../../src/workspace/local-filesystem-workspace.ts";
import type { WorkspaceEntry, WorkspacePort } from "../../../src/workspace/port.ts";
import { ReadOnlyWorkspace, WorkspaceIsReadOnly } from "../../../src/workspace/read-only-workspace.ts";

const READ_PERMISSIONS = ["workspace:read"];
const WRITE_PERMISSIONS = ["workspace:write"];
let root: string | undefined;

function buildFixture(port: WorkspacePort, rootPath: string) {
	const registry: MutableRegistry = new Map([["ws", { port, rootPath, origin: "local" as const }]]);
	const coordinator = new MutationHistoryCoordinator({ registry, createStore: () => new InMemoryMutationHistory() });
	const vehicleRegistry = new VehicleRegistry({ name: "lector-mutation-history-error-mapping", version: "1.0.0", description: "test" });
	registerMutationHistoryOperations(vehicleRegistry, registry, coordinator.handlers);
	return { vehicleRegistry, coordinator };
}

async function invokeAndCatch(
	vehicleRegistry: VehicleRegistry,
	name: string,
	permissions: readonly string[],
	input: Record<string, unknown>,
): Promise<VehicleError> {
	const error = await vehicleRegistry.invoke(name, 1, input, { permissions }).catch((caught: unknown) => caught);
	if (!isVehicleError(error)) throw new Error(`expected a VehicleError, got ${String(error)}`);
	return error;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("mutation history operation error mapping", () => {
	it("maps UnknownWorkspace to a coded VehicleError on workspace.mutationHistory, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-mutation-history-error-mapping-unknown-"));
		const { vehicleRegistry } = buildFixture(new LocalFilesystemWorkspace(root), root);

		const error = await invokeAndCatch(vehicleRegistry, "workspace.mutationHistory", READ_PERMISSIONS, {
			workspaceId: "never-registered",
			path: "a.ts",
			maxResults: 10,
		});
		expect(error.code).toBe("unknown-workspace");
		expect(error.category).toBe("not_found");
		expect(error.cause).toBeInstanceOf(UnknownWorkspace);
	});

	it("maps MutationEntryNotFound to a coded VehicleError on workspace.revertMutation, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-mutation-history-error-mapping-not-found-"));
		const { vehicleRegistry } = buildFixture(new LocalFilesystemWorkspace(root), root);

		const error = await invokeAndCatch(vehicleRegistry, "workspace.revertMutation", WRITE_PERMISSIONS, { workspaceId: "ws", entryId: "never-recorded" });
		expect(error.code).toBe("mutation-entry-not-found");
		expect(error.category).toBe("not_found");
		expect(error.cause).toBeInstanceOf(MutationEntryNotFound);
	});

	it("maps MutationRevertStale to a coded VehicleError, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-mutation-history-error-mapping-stale-"));
		writeFileSync(join(root, "a.ts"), "v1");
		const workspace = new LocalFilesystemWorkspace(root);
		const { vehicleRegistry, coordinator } = buildFixture(workspace, root);

		const initial = await workspace.readEntry("a.ts");
		const written = await coordinator.record("ws", "a.ts", "exactEdit", async () => {
			const outcome = await workspace.writeEntry("a.ts", initial.exists ? contentHashOf(initial.content) : null, "v2");
			return { newHash: outcome.newHash };
		});
		void written;
		const entries = await coordinator.handlers["workspace.mutationHistory"](new Map(), { workspaceId: "ws", path: "a.ts", maxResults: 10 });
		const entryId = entries.entries[0]?.id;
		if (!entryId) throw new Error("expected a recorded entry");

		// A later, unrelated write changes the file again -- the recorded revert target is now stale.
		const current = await workspace.readEntry("a.ts");
		await workspace.writeEntry("a.ts", current.exists ? contentHashOf(current.content) : null, "v3 -- someone else's change");

		const error = await invokeAndCatch(vehicleRegistry, "workspace.revertMutation", WRITE_PERMISSIONS, { workspaceId: "ws", entryId });
		expect(error.code).toBe("mutation-revert-stale");
		expect(error.category).toBe("conflict");
		expect(error.cause).toBeInstanceOf(MutationRevertStale);
	});

	it("maps WorkspaceIsReadOnly to a coded VehicleError, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-mutation-history-error-mapping-readonly-"));
		writeFileSync(join(root, "a.ts"), "v1");
		const inner = new LocalFilesystemWorkspace(root);
		const readOnly = new ReadOnlyWorkspace(inner);
		const { vehicleRegistry, coordinator } = buildFixture(readOnly, root);

		// Seed a real, currently-revertible entry via the writable inner workspace directly, bypassing the read-only wrapper's own guard.
		const initial = await inner.readEntry("a.ts");
		await coordinator.record("ws", "a.ts", "exactEdit", async () => {
			const outcome = await inner.writeEntry("a.ts", initial.exists ? contentHashOf(initial.content) : null, "v2");
			return { newHash: outcome.newHash };
		});
		const entries = await coordinator.handlers["workspace.mutationHistory"](new Map(), { workspaceId: "ws", path: "a.ts", maxResults: 10 });
		const entryId = entries.entries[0]?.id;
		if (!entryId) throw new Error("expected a recorded entry");

		const error = await invokeAndCatch(vehicleRegistry, "workspace.revertMutation", WRITE_PERMISSIONS, { workspaceId: "ws", entryId });
		expect(error.code).toBe("workspace-is-read-only");
		expect(error.category).toBe("authorization");
		expect(error.cause).toBeInstanceOf(WorkspaceIsReadOnly);
	});

	it("maps a race-time StaleExpectedHash to a coded VehicleError, keeping it as cause", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-mutation-history-error-mapping-race-"));
		writeFileSync(join(root, "a.ts"), "v1");
		const inner = new LocalFilesystemWorkspace(root);
		// Simulates the narrow ABA window canRevertMutation's own pre-check cannot close: the
		// pre-check passes (currentHash still matches), but the real write races another writer.
		const racy: WorkspacePort = {
			resolvePath: (path) => inner.resolvePath(path),
			readEntry: (path): Promise<WorkspaceEntry> => inner.readEntry(path),
			writeEntry: () => {
				throw new StaleExpectedHash("a.ts", "expected" as ContentHash, "actual" as ContentHash);
			},
			deleteEntry: () => {
				throw new StaleExpectedHash("a.ts", "expected" as ContentHash, "actual" as ContentHash);
			},
		};
		const { vehicleRegistry, coordinator } = buildFixture(racy, root);

		const initial = await inner.readEntry("a.ts");
		await coordinator.record("ws", "a.ts", "exactEdit", async () => {
			const outcome = await inner.writeEntry("a.ts", initial.exists ? contentHashOf(initial.content) : null, "v2");
			return { newHash: outcome.newHash };
		});
		const entries = await coordinator.handlers["workspace.mutationHistory"](new Map(), { workspaceId: "ws", path: "a.ts", maxResults: 10 });
		const entryId = entries.entries[0]?.id;
		if (!entryId) throw new Error("expected a recorded entry");

		const error = await invokeAndCatch(vehicleRegistry, "workspace.revertMutation", WRITE_PERMISSIONS, { workspaceId: "ws", entryId });
		expect(error.code).toBe("stale-expected-hash");
		expect(error.category).toBe("conflict");
		expect(error.cause).toBeInstanceOf(StaleExpectedHash);
	});

	it("declares each operation's own error catalog in the manifest", () => {
		root = mkdtempSync(join(tmpdir(), "lector-mutation-history-error-mapping-manifest-"));
		const { vehicleRegistry } = buildFixture(new LocalFilesystemWorkspace(root), root);

		const manifest = vehicleRegistry.manifest();
		const history = manifest.operations.find((candidate) => candidate.name === "workspace.mutationHistory");
		expect(history?.errors.map((failure) => failure.code).sort()).toEqual(["unknown-workspace"]);

		const revert = manifest.operations.find((candidate) => candidate.name === "workspace.revertMutation");
		expect(revert?.errors.map((failure) => failure.code).sort()).toEqual(
			["unknown-workspace", "mutation-entry-not-found", "mutation-revert-stale", "stale-expected-hash", "workspace-is-read-only"].sort(),
		);
	});
});
