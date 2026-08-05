/**
 * Service-level wiring for workspace.applyPatch: dispatch resolves the right workspace and
 * forwards to the real domain function. Real hunk-context matching/atomicity is already
 * covered directly in test/domain/apply-patch.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { contentHashOf } from "../src/content-identity/content-hash.ts";
import { createLectorService, type LectorService, UnknownWorkspace } from "../src/service.ts";

let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
});

describe("createLectorService's workspace.applyPatch", () => {
	it("rejects an unknown workspaceId before ever touching the domain function", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(
			service.dispatch("workspace.applyPatch", {
				workspaceId: "never-registered",
				path: "a.ts",
				expectedHash: contentHashOf("anything"),
				patchText: "@@ -1,1 +1,1 @@\n-a\n+b\n",
			}),
		).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("routes a real patch through to the registered workspace", async () => {
		const { InMemoryWorkspace } = await import("../src/workspace/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));
		const content = "line 1\nline 2";
		await service.dispatch("workspace.exactEdit", { workspaceId: "mem-1", path: "a.ts", expectedHash: null, content });

		const outcome = await service.dispatch("workspace.applyPatch", {
			workspaceId: "mem-1",
			path: "a.ts",
			expectedHash: contentHashOf(content),
			patchText: "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 patched\n",
		});

		expect(outcome.path).toBe("a.ts");
		const read = await service.dispatch("workspace.rawRead", { workspaceId: "mem-1", path: "a.ts" });
		expect(read.content).toBe("line 1\nline 2 patched");
	});
});
