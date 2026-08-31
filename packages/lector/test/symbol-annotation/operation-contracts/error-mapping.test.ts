/**
 * mapAnnotationError must code/categorize each reachable domain error, preserve the original as
 * cause, and declare the matching codes on each operation's own descriptor (they differ per
 * operation, the same way repo-fetch's do).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { AnnotationHandlers } from "../../../src/service/annotation-handlers.ts";
import {
	AnnotationContainmentCycle,
	AnnotationRequiresAnchors,
	UnknownAnnotationAnchor,
	UnknownAnnotationForContainment,
} from "../../../src/service/errors.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";
import { registerAnnotationOperations } from "../../../src/symbol-annotation/operation-registration.ts";
import { InMemorySymbolGraph } from "../../../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../../src/symbol-graph/symbol-node-id.ts";
import { LocalFilesystemWorkspace } from "../../../src/workspace/local-filesystem-workspace.ts";

const WRITE_PERMISSIONS = ["workspace:write"];
let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

/** A real anchorable position, seeded into the graph -- every createAnnotation call needs at least one real anchor except the AnnotationRequiresAnchors test itself. */
function buildFixture() {
	root = mkdtempSync(join(tmpdir(), "lector-vehicle-annotation-error-mapping-"));
	mkdirSync(join(root, "src"));
	const path = join(root, "src", "a.ts");
	writeFileSync(path, "export function add() {}\n");

	const registry: MutableRegistry = new Map([["ws", { port: new LocalFilesystemWorkspace(root), rootPath: root, origin: "local" as const }]]);
	const graph = new InMemorySymbolGraph();
	graph.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });
	const handlers = new AnnotationHandlers({
		registry,
		graph: () => graph,
		cacheStatus: () => {
			throw new Error("cacheStatus is not exercised by this test");
		},
		populateSymbolGraph: () => {
			throw new Error("populateSymbolGraph is not exercised by this test");
		},
	});
	const vehicleRegistry = new VehicleRegistry({ name: "lector-annotation-error-mapping", version: "1.0.0", description: "test" });
	registerAnnotationOperations(vehicleRegistry, registry, handlers);
	return { registry, handlers, vehicleRegistry, anchors: [{ path, line: 1, character: 1 }] };
}

async function invokeAndCatch(vehicleRegistry: VehicleRegistry, name: string, input: unknown): Promise<VehicleError> {
	const error = await vehicleRegistry.invoke(name, 1, input, { permissions: WRITE_PERMISSIONS }).catch((caught: unknown) => caught);
	if (!isVehicleError(error)) throw new Error(`expected a VehicleError, got ${String(error)}`);
	return error;
}

describe("annotation error mapping", () => {
	it("maps AnnotationRequiresAnchors to a coded VehicleError on createAnnotation", async () => {
		const { vehicleRegistry } = buildFixture();
		const error = await invokeAndCatch(vehicleRegistry, "workspace.createAnnotation", { workspaceId: "ws", subtype: "n", title: "t", body: "b", anchors: [] });
		expect(error.code).toBe("annotation-requires-anchors");
		expect(error.category).toBe("validation");
		expect(error.cause).toBeInstanceOf(AnnotationRequiresAnchors);
	});

	it("maps UnknownAnnotationAnchor to a coded VehicleError on createAnnotation", async () => {
		const { vehicleRegistry } = buildFixture();
		const anchors = [{ path: "does-not-exist.ts", line: 1, character: 1 }];
		const error = await invokeAndCatch(vehicleRegistry, "workspace.createAnnotation", { workspaceId: "ws", subtype: "n", title: "t", body: "b", anchors });
		expect(error.code).toBe("unknown-annotation-anchor");
		expect(error.category).toBe("not_found");
		expect(error.cause).toBeInstanceOf(UnknownAnnotationAnchor);
	});

	it("maps UnknownAnnotationForContainment to a coded VehicleError on containAnnotation", async () => {
		const { vehicleRegistry } = buildFixture();
		const error = await invokeAndCatch(vehicleRegistry, "workspace.containAnnotation", { workspaceId: "ws", parentId: "missing-1", childId: "missing-2" });
		expect(error.code).toBe("unknown-annotation-for-containment");
		expect(error.category).toBe("not_found");
		expect(error.cause).toBeInstanceOf(UnknownAnnotationForContainment);
	});

	it("maps AnnotationContainmentCycle to a coded VehicleError on containAnnotation", async () => {
		const { registry, handlers, vehicleRegistry, anchors } = buildFixture();
		const parent = await handlers.handlers["workspace.createAnnotation"](registry, { workspaceId: "ws", subtype: "n", title: "p", body: "b", anchors });
		const child = await handlers.handlers["workspace.createAnnotation"](registry, { workspaceId: "ws", subtype: "n", title: "c", body: "b", anchors });
		await handlers.handlers["workspace.containAnnotation"](registry, { workspaceId: "ws", parentId: parent.annotation.id, childId: child.annotation.id });

		const error = await invokeAndCatch(vehicleRegistry, "workspace.containAnnotation", {
			workspaceId: "ws",
			parentId: child.annotation.id,
			childId: parent.annotation.id,
		});
		expect(error.code).toBe("annotation-containment-cycle");
		expect(error.category).toBe("conflict");
		expect(error.cause).toBeInstanceOf(AnnotationContainmentCycle);
	});

	it("declares a per-operation error catalog through manifest(), not one shared superset", () => {
		const { vehicleRegistry } = buildFixture();
		const manifest = vehicleRegistry.manifest();
		const codesFor = (name: string) =>
			manifest.operations
				.find((op) => op.name === name)
				?.errors.map((failure) => failure.code)
				.sort();

		const anchorErrors = ["unknown-workspace", "annotation-requires-anchors", "unknown-annotation-anchor", "auto-populate-requires-bounds"].sort();
		expect(codesFor("workspace.createAnnotation")).toEqual(anchorErrors);
		expect(codesFor("workspace.refreshAnnotation")).toEqual(anchorErrors);
		expect(codesFor("workspace.getAnnotation")).toEqual(["unknown-workspace"]);
		expect(codesFor("workspace.containAnnotation")).toEqual(["unknown-workspace", "unknown-annotation-for-containment", "annotation-containment-cycle"].sort());
	});
});
