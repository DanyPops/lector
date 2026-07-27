/**
 * Service-level wiring for workspace.lineEdit: dispatch resolves the right workspace and
 * forwards to the real domain function. Real per-edit validation/atomicity is already covered
 * directly in test/domain/line-edit.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { lineHashOf } from "../src/domain/line-hash.ts";
import { createLectorService, type LectorService, UnknownWorkspace } from "../src/service.ts";

let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
});

describe("createLectorService's workspace.lineEdit", () => {
	it("rejects an unknown workspaceId before ever touching the domain function", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(
			service.dispatch("workspace.lineEdit", {
				workspaceId: "never-registered",
				path: "a.ts",
				edits: [{ kind: "replace", startLine: 1, endLine: 1, expectedStartHash: lineHashOf("x"), expectedEndHash: lineHashOf("x"), lines: ["y"] }],
			}),
		).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("routes a real edit through to the registered workspace", async () => {
		const { InMemoryWorkspace } = await import("../src/adapters/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "mem-1", path: "a.ts", expectedHash: null, content: "line 1\nline 2" });

		const outcome = await service.dispatch("workspace.lineEdit", {
			workspaceId: "mem-1",
			path: "a.ts",
			edits: [
				{ kind: "replace", startLine: 2, endLine: 2, expectedStartHash: lineHashOf("line 2"), expectedEndHash: lineHashOf("line 2"), lines: ["replaced"] },
			],
		});

		expect(outcome.path).toBe("a.ts");
		const read = await service.dispatch("workspace.rawRead", { workspaceId: "mem-1", path: "a.ts" });
		expect(read.content).toBe("line 1\nreplaced");
	});

	it("a rejected edit's error message spells out every failure, not just a bare count -- the daemon RPC boundary carries only this string", async () => {
		const { InMemoryWorkspace } = await import("../src/adapters/in-memory-workspace.ts");
		service = createLectorService(new Map([["mem-1", new InMemoryWorkspace()]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "mem-1", path: "a.ts", expectedHash: null, content: "line 1\nline 2" });

		const attempt = service.dispatch("workspace.lineEdit", {
			workspaceId: "mem-1",
			path: "a.ts",
			edits: [{ kind: "replace", startLine: 1, endLine: 1, expectedStartHash: lineHashOf("wrong"), expectedEndHash: lineHashOf("wrong"), lines: ["x"] }],
		});

		await expect(attempt).rejects.toThrow(/hash-mismatch/);
		await expect(attempt).rejects.toThrow(/edit 0/);
	});
});
