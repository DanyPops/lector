/**
 * Lector's service has no implicit fallback to a prior operation's target
 * identity: every operation names its workspaceId explicitly, and an
 * unknown id fails closed rather than silently reusing whichever
 * workspace a previous call happened to target.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { type LectorDaemonOptions, startLectorDaemon } from "../src/daemon.ts";
import { createLectorService, UnknownWorkspace } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

describe("createLectorService", () => {
	it("rejects an operation naming a workspaceId nothing was registered under", async () => {
		const service = createLectorService(new Map([["a", new InMemoryWorkspace()]]));

		await expect(service.dispatch("workspace.rawRead", { workspaceId: "b", path: "x.txt" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("never returns one workspace's data for a different workspace's id", async () => {
		const workspaceA = new InMemoryWorkspace();
		const workspaceB = new InMemoryWorkspace();
		const service = createLectorService(
			new Map([
				["a", workspaceA],
				["b", workspaceB],
			]),
		);
		await service.dispatch("workspace.exactEdit", { workspaceId: "a", path: "x.txt", expectedHash: null, content: "from a" });
		await service.dispatch("workspace.exactEdit", { workspaceId: "b", path: "x.txt", expectedHash: null, content: "from b" });

		const readA = await service.dispatch("workspace.rawRead", { workspaceId: "a", path: "x.txt" });
		const readB = await service.dispatch("workspace.rawRead", { workspaceId: "b", path: "x.txt" });

		expect(readA.content).toBe("from a");
		expect(readB.content).toBe("from b");
	});

	it("dispatch rejects rather than throws synchronously for an unknown workspaceId", () => {
		// Regression guard: dispatch must always return a promise, never throw synchronously,
		// so in-process callers (standalone mode, a future Alef adapter) that aren't wrapped in
		// the HTTP layer's try/catch don't crash unexpectedly. Deliberately does not use
		// `await`/`.rejects` here -- the point is to prove `dispatch(...)` itself never throws
		// when called, only the returned promise settles rejected.
		const service = createLectorService(new Map([["a", new InMemoryWorkspace()]]));
		let result: Promise<unknown> | undefined;
		expect(() => {
			result = service.dispatch("workspace.rawRead", { workspaceId: "missing", path: "x.txt" });
		}).not.toThrow();
		expect(result).toBeInstanceOf(Promise);
		return expect(result).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("a call against a workspaceId registered after an earlier call is unaffected by that earlier call's target", async () => {
		const workspaceA = new InMemoryWorkspace();
		const service = createLectorService(new Map([["a", workspaceA]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "a", path: "x.txt", expectedHash: null, content: "from a" });

		// "c" was never registered -- must fail closed, never silently resolve to "a" because
		// "a" happens to be the only (or most recently used) workspace.
		await expect(service.dispatch("workspace.rawRead", { workspaceId: "c", path: "x.txt" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});
});

describe("the real daemon enforces the same explicit-identity rule over HTTP", () => {
	let cleanup: (() => void) | undefined;
	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it("returns a client-visible error for an unregistered workspaceId instead of another workspace's data", async () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const workspaces: LectorDaemonOptions["workspaces"] = new Map([["a", new InMemoryWorkspace()]]);
		const daemon = await startLectorDaemon({ workspaces, paths });
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};

		const token = (await import("node:fs")).readFileSync(paths.token, "utf8").trim();
		const response = await fetch(`http://${daemon.host}:${daemon.port}/api/v1/ops`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ op: "workspace.rawRead", input: { workspaceId: "does-not-exist", path: "x.txt" } }),
		});

		expect(response.ok).toBe(false);
		const body = (await response.json()) as { error?: string };
		expect(body.error).toContain("does-not-exist");
	});
});
