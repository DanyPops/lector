import { describe, expect, it } from "bun:test";
import { type LectorOperations, withWorkspaceRecovery } from "../src/lector-operations.js";
import { createWorkspaceRootRegistry } from "../src/workspace-root-registry.js";

function unknownWorkspaceError(workspaceId: string): Error {
	return new Error(`UnknownWorkspace: no workspace registered under id "${workspaceId}"`);
}

function fakeOperations(behavior: (operation: string, input: unknown) => unknown): LectorOperations {
	return { call: async (operation, input) => behavior(operation, input) };
}

describe("withWorkspaceRecovery", () => {
	it("passes a successful call straight through without touching the registry", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const inner = fakeOperations((operation, input) => {
			calls.push({ operation, input });
			return { ok: true };
		});
		const wrapped = withWorkspaceRecovery(inner, createWorkspaceRootRegistry());

		await expect(wrapped.call("workspace.gitStatus", { workspaceId: "abc" })).resolves.toEqual({ ok: true });
		expect(calls).toHaveLength(1);
	});

	it("re-registers the remembered root and transparently retries the original call once on UnknownWorkspace", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		let failNextGitStatus = true;
		const inner = fakeOperations((operation, input) => {
			calls.push({ operation, input });
			if (operation === "workspace.gitStatus" && failNextGitStatus) {
				failNextGitStatus = false;
				throw unknownWorkspaceError("abc");
			}
			if (operation === "workspace.registerPath") return { workspaceId: "abc", created: true };
			return { ok: true, files: [] };
		});
		const roots = createWorkspaceRootRegistry();
		roots.remember("abc", "/repo/root");
		const wrapped = withWorkspaceRecovery(inner, roots);

		await expect(wrapped.call("workspace.gitStatus", { workspaceId: "abc" })).resolves.toEqual({ ok: true, files: [] });
		expect(calls).toEqual([
			{ operation: "workspace.gitStatus", input: { workspaceId: "abc" } },
			{ operation: "workspace.registerPath", input: { path: "/repo/root" } },
			{ operation: "workspace.gitStatus", input: { workspaceId: "abc" } },
		]);
	});

	it("rethrows UnknownWorkspace unchanged when the registry never learned this workspaceId's root", async () => {
		const inner = fakeOperations(() => {
			throw unknownWorkspaceError("never-opened");
		});
		const wrapped = withWorkspaceRecovery(inner, createWorkspaceRootRegistry());

		await expect(wrapped.call("workspace.gitStatus", { workspaceId: "never-opened" })).rejects.toThrow(/UnknownWorkspace/);
	});

	it("rethrows a second, still-failing UnknownWorkspace after exactly one recovery attempt rather than looping", async () => {
		const inner = fakeOperations((operation) => {
			if (operation === "workspace.registerPath") return { workspaceId: "abc", created: true };
			throw unknownWorkspaceError("abc");
		});
		const roots = createWorkspaceRootRegistry();
		roots.remember("abc", "/repo/root");
		const wrapped = withWorkspaceRecovery(inner, roots);

		await expect(wrapped.call("workspace.gitStatus", { workspaceId: "abc" })).rejects.toThrow(/UnknownWorkspace/);
	});

	it("never touches an error unrelated to UnknownWorkspace", async () => {
		const inner = fakeOperations(() => {
			throw new Error("NotAGitRepository: not a git repository");
		});
		const wrapped = withWorkspaceRecovery(inner, createWorkspaceRootRegistry());

		await expect(wrapped.call("workspace.gitStatus", { workspaceId: "abc" })).rejects.toThrow(/NotAGitRepository/);
	});

	it("passes through an input with no workspaceId field unchanged when it errors", async () => {
		const inner = fakeOperations(() => {
			throw unknownWorkspaceError("abc");
		});
		const wrapped = withWorkspaceRecovery(inner, createWorkspaceRootRegistry());

		await expect(wrapped.call("workspace.gitStatus", {})).rejects.toThrow(/UnknownWorkspace/);
	});
});
