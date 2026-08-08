/** dispatch() for repo.fetch/listCache/evictCache must route through VehicleRegistry.invoke(), proven by a failure mode only that path produces. */
import { describe, expect, it } from "bun:test";
import { isVehicleError } from "@danypops/vehicle-core";
import { createLectorService } from "../../../src/service.ts";

describe("createLectorService's repo-fetch dispatch", () => {
	it("a missing ref fails with a structured VehicleError from invoke()'s input validation", async () => {
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const malformedInput = { host: "github.com", owner: "a", repo: "b" } as unknown as Parameters<typeof service.dispatch<"repo.fetch">>[1];
			const error = await service.dispatch("repo.fetch", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as import("@danypops/vehicle-core").VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.category).toBe("validation");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["ref"], message: "ref is required (use null for the remote's default branch)" }] });
		} finally {
			await service.close();
		}
	});

	it("a non-numeric maxResults fails with a structured VehicleError on repo.listCache", async () => {
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const malformedInput = { maxResults: "10" } as unknown as Parameters<typeof service.dispatch<"repo.listCache">>[1];
			const error = await service.dispatch("repo.listCache", malformedInput).catch((caught: unknown) => caught);

			expect(isVehicleError(error)).toBe(true);
			const vehicleError = error as import("@danypops/vehicle-core").VehicleError;
			expect(vehicleError.code).toBe("invalid-input");
			expect(vehicleError.details).toEqual({ issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer" }] });
		} finally {
			await service.close();
		}
	});
});
