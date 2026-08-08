/**
 * Vehicle migration Phase 2 proof: createLectorService's real dispatch() for gitStatus/gitLog/
 * gitDiff genuinely routes through the VehicleRegistry now, not just an unused parallel module.
 * service-git.test.ts (unchanged by this phase) already proves external behavior didn't regress;
 * this test proves the opposite direction -- a validation layer that only exists on the Vehicle
 * path (requireMaxCount in service/vehicle/git-operations.ts) actually fires through dispatch().
 * The old direct-to-GitHandlers path never validated maxCount's type at all before handing it
 * straight to LocalGit -- a malformed value would have produced whatever `git log -n NaN` (or
 * similar) does, not a clean, immediate TypeError.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService } from "../../../src/service.ts";

describe("Vehicle migration Phase 2: createLectorService's git dispatch", () => {
	it("a malformed maxCount fails fast with the Vehicle-side TypeError, proving dispatch() really goes through VehicleRegistry", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-vehicle-dispatch-"));
		const service = createLectorService(new Map(), { allowDynamicOnly: true });
		try {
			const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
			const malformedInput = { workspaceId, maxCount: "not-a-number" } as unknown as Parameters<typeof service.dispatch<"workspace.gitLog">>[1];
			await expect(service.dispatch("workspace.gitLog", malformedInput)).rejects.toThrow(/maxCount must be a positive safe integer/);
		} finally {
			await service.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
