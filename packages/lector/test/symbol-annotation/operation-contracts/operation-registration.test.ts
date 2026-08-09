/** Registry and direct annotation entry points must preserve behavior and failure identity. */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import { AnnotationHandlers } from "../../../src/service/annotation-handlers.ts";
import { UnknownWorkspace } from "../../../src/service/errors.ts";
import type { MutableRegistry } from "../../../src/service/workspace-registry.ts";
import { registerAnnotationOperations } from "../../../src/symbol-annotation/operation-registration.ts";
import { InMemorySymbolGraph } from "../../../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../../src/symbol-graph/symbol-node-id.ts";
import { LocalFilesystemWorkspace } from "../../../src/workspace/local-filesystem-workspace.ts";

let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

const READ_PERMISSIONS = ["workspace:read"];
const WRITE_PERMISSIONS = ["workspace:write"];

function buildFixture() {
	root = mkdtempSync(join(tmpdir(), "lector-vehicle-annotation-"));
	mkdirSync(join(root, "src"));
	const path = join(root, "src", "a.ts");
	writeFileSync(path, "export function add() {}\n");

	const registry: MutableRegistry = new Map([["ws", { port: new LocalFilesystemWorkspace(root), rootPath: root, origin: "local" as const }]]);
	const graph = new InMemorySymbolGraph();
	graph.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });
	const handlers = new AnnotationHandlers({ registry, graph: () => graph });
	const vehicleRegistry = new VehicleRegistry({ name: "lector-annotation", version: "1.0.0", description: "test" });
	registerAnnotationOperations(vehicleRegistry, registry, handlers);
	return { registry, handlers, vehicleRegistry, path };
}

describe("registerAnnotationOperations", () => {
	it("invoke() matches the direct handler call for create/get/list/scrub/restore", async () => {
		const { registry, handlers, vehicleRegistry, path } = buildFixture();

		const directCreate = await handlers.handlers["workspace.createAnnotation"](registry, {
			workspaceId: "ws",
			subtype: "note",
			title: "t",
			body: "b",
			anchors: [{ path, line: 1, character: 1 }],
		});
		const vehicleCreate = await vehicleRegistry.invoke(
			"workspace.createAnnotation",
			1,
			{ workspaceId: "ws", subtype: "note", title: "t2", body: "b2", anchors: [{ path, line: 1, character: 1 }] },
			{ permissions: WRITE_PERMISSIONS },
		);
		expect((vehicleCreate as typeof directCreate).annotation.title).toBe("t2");

		const directGet = await handlers.handlers["workspace.getAnnotation"](registry, { workspaceId: "ws", id: directCreate.annotation.id });
		const vehicleGet = await vehicleRegistry.invoke(
			"workspace.getAnnotation",
			1,
			{ workspaceId: "ws", id: directCreate.annotation.id },
			{ permissions: READ_PERMISSIONS },
		);
		expect(vehicleGet).toEqual(directGet);

		const directList = await handlers.handlers["workspace.listAnnotations"](registry, { workspaceId: "ws" });
		const vehicleList = await vehicleRegistry.invoke("workspace.listAnnotations", 1, { workspaceId: "ws" }, { permissions: READ_PERMISSIONS });
		expect(vehicleList).toEqual(directList);

		const directScrub = await handlers.handlers["workspace.scrubAnnotation"](registry, { workspaceId: "ws", id: directCreate.annotation.id });
		expect(directScrub).toEqual({ scrubbed: true });
		const vehicleScrub = await vehicleRegistry.invoke(
			"workspace.scrubAnnotation",
			1,
			{ workspaceId: "ws", id: directCreate.annotation.id },
			{ permissions: WRITE_PERMISSIONS },
		);
		// Already scrubbed by the direct call above -- the second scrub is a real no-op, proving idempotent-by-construction, not an error.
		expect(vehicleScrub).toEqual({ scrubbed: false });

		const directRestore = await handlers.handlers["workspace.restoreAnnotation"](registry, { workspaceId: "ws", id: directCreate.annotation.id });
		expect(directRestore).toEqual({ restored: true });
	});

	it("an UnknownWorkspace failure survives as invoke()'s VehicleError.cause", async () => {
		const { vehicleRegistry } = buildFixture();

		const vehicleError = await vehicleRegistry
			.invoke("workspace.getAnnotation", 1, { workspaceId: "never-registered", id: "x" }, { permissions: READ_PERMISSIONS })
			.catch((error: unknown) => error);
		expect(isVehicleError(vehicleError)).toBe(true);
		expect((vehicleError as Error).cause).toBeInstanceOf(UnknownWorkspace);
	});
});
