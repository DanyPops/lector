import { describe, expect, it } from "bun:test";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import { createLectorService } from "../../src/service.ts";

describe("code-action Vehicle operations", () => {
	it("routes preview through its authenticated runtime schema", async () => {
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const malformed = {
				workspaceId: "ws",
				path: "/tmp/a.ts",
				range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
				maxActions: 0,
				maxEdits: 1,
				maxFiles: 1,
				maxBytes: 1,
				deadlineMs: 1,
			} as unknown as Parameters<typeof service.dispatch<"workspace.previewCodeActions">>[1];
			const error = await service.dispatch("workspace.previewCodeActions", malformed).catch((caught: unknown) => caught);
			expect(isVehicleError(error)).toBe(true);
			expect((error as VehicleError).code).toBe("invalid-input");
			expect((error as VehicleError).details).toEqual({
				issues: [{ path: ["maxActions"], message: "maxActions must be a positive safe integer" }],
			});
		} finally {
			await service.close();
		}
	});

	it("enforces distinct preview and apply permissions", async () => {
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const previewError = await service.operationRegistry
				.invoke(
					"workspace.previewCodeActions",
					1,
					{
						workspaceId: "ws",
						path: "/tmp/a.ts",
						range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
						maxActions: 1,
						maxEdits: 1,
						maxFiles: 1,
						maxBytes: 1_000,
						deadlineMs: 1_000,
					},
					{ permissions: [] },
				)
				.catch((caught: unknown) => caught);
			const applyError = await service.operationRegistry
				.invoke("workspace.applyCodeAction", 1, { workspaceId: "ws", previewId: "preview" }, { permissions: ["workspace:read"] })
				.catch((caught: unknown) => caught);
			expect(isVehicleError(previewError)).toBe(true);
			expect(isVehicleError(applyError)).toBe(true);
			expect((previewError as VehicleError).category).toBe("authorization");
			expect((applyError as VehicleError).category).toBe("authorization");
		} finally {
			await service.close();
		}
	});
});
