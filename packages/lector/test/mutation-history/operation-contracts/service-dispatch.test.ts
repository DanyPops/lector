/** dispatch() for mutationHistory/revertMutation must route through VehicleRegistry.invoke(), proven by a failure mode (structured schema validation) only that path produces. */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import { createLectorService } from "../../../src/service.ts";

describe("createLectorService's mutation-history dispatch", () => {
	it("a malformed maxResults fails with a structured VehicleError from invoke()'s input validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-mutation-history-dispatch-"));
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
			const malformedInput = { workspaceId, path: "a.ts", maxResults: "not-a-number" } as unknown as Parameters<
				typeof service.dispatch<"workspace.mutationHistory">
			>[1];
			const error = await service.dispatch("workspace.mutationHistory", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.category).toBe("validation");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer" }] });
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a missing entryId fails with a structured VehicleError on workspace.revertMutation", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-mutation-history-dispatch-revert-"));
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
			const malformedInput = { workspaceId } as unknown as Parameters<typeof service.dispatch<"workspace.revertMutation">>[1];
			const error = await service.dispatch("workspace.revertMutation", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["entryId"], message: "entryId must be a non-empty string" }] });
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
