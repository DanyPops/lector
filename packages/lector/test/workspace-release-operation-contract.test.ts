import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { createLectorService, type LectorService } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("workspace.release Vehicle contract", () => {
	it("is registered and invokes the existing lifecycle handler", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-release-contract-"));
		writeFileSync(join(root, "a.ts"), "export const value = 1;\n");
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const registered = await service.dispatch("workspace.registerPath", { path: root });

		const descriptor = service.operationRegistry.manifest().operations.find((operation) => operation.name === "workspace.release");
		expect(descriptor).toMatchObject({ version: 1, effect: "local-write" });
		const released = await service.operationRegistry.invoke(
			"workspace.release",
			1,
			{ workspaceId: registered.workspaceId },
			{ permissions: ["workspace:write"] },
		);
		expect(released).toEqual({ workspaceId: registered.workspaceId, closedIndexes: 0, closedGraph: false, closedWatch: false });
	});

	it("validates input and maps unknown workspace errors", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const invalid = await service.operationRegistry.invoke("workspace.release", 1, {}, { permissions: ["workspace:write"] }).catch((error: unknown) => error);
		expect(isVehicleError(invalid)).toBe(true);
		if (isVehicleError(invalid)) expect(invalid.code).toBe("invalid-input");

		const unknown = await service.operationRegistry
			.invoke("workspace.release", 1, { workspaceId: "unknown" }, { permissions: ["workspace:write"] })
			.catch((error: unknown) => error);
		expect(isVehicleError(unknown)).toBe(true);
		if (isVehicleError(unknown)) expect(unknown.code).toBe("unknown-workspace");
	});
});
