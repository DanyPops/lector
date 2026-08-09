/** dispatch() for gitStatus/gitLog/gitDiff must route through VehicleRegistry.invoke(), proven by a failure mode (structured schema validation) only that path produces. */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError } from "@danypops/vehicle-core";
import { createLectorService } from "../../../src/service.ts";

describe("createLectorService's git dispatch", () => {
	it("a malformed maxCount fails with a structured VehicleError from invoke()'s input validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-vehicle-dispatch-"));
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
			const malformedInput = { workspaceId, maxCount: "not-a-number" } as unknown as Parameters<typeof service.dispatch<"workspace.gitLog">>[1];
			const error = await service.dispatch("workspace.gitLog", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as import("@danypops/vehicle-core").VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.category).toBe("validation");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["maxCount"], message: "maxCount must be a positive safe integer" }] });
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
