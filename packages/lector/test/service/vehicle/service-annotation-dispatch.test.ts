/** dispatch() for the annotation operations must route through VehicleRegistry.invoke(), proven by a failure mode only that path produces. */
import { describe, expect, it } from "bun:test";
import { isVehicleError } from "@danypops/vehicle-core";
import { createLectorService } from "../../../src/service.ts";

describe("createLectorService's annotation dispatch", () => {
	it("an out-of-enum status filter fails with a structured VehicleError on listAnnotations", async () => {
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const malformedInput = { workspaceId: "ws", status: "deleted" } as unknown as Parameters<typeof service.dispatch<"workspace.listAnnotations">>[1];
			const error = await service.dispatch("workspace.listAnnotations", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as import("@danypops/vehicle-core").VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["status"], message: "status must be one of fresh, stale, scrubbed when given" }] });
		} finally {
			await service.close();
		}
	});

	it("a negative maxDepth fails with a structured VehicleError on annotationTree", async () => {
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const malformedInput = { workspaceId: "ws", rootId: "r", maxDepth: -1 } as unknown as Parameters<typeof service.dispatch<"workspace.annotationTree">>[1];
			const error = await service.dispatch("workspace.annotationTree", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as import("@danypops/vehicle-core").VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["maxDepth"], message: "maxDepth must be a non-negative safe integer" }] });
		} finally {
			await service.close();
		}
	});
});
