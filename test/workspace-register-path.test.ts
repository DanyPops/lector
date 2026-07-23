/**
 * Checklist (task 8cc5553f): dynamic path-based workspace registration.
 * Prerequisite for pi-lector: a host adapter knows only "the cwd Pi is
 * running in", not a pre-declared workspaceId, so it needs a way to turn a
 * real directory into a registered workspace at runtime rather than
 * requiring `lector serve` to have known about every project upfront.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { InvalidWorkspaceRoot, createLectorService, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanupFns: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanupFns.reverse()) await fn();
	cleanupFns = [];
});

async function freshProjectDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lector-register-"));
	cleanupFns.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("workspace.registerPath", () => {
	it("registering the same path twice returns the same workspaceId, and reports created:false the second time", async () => {
		const projectDir = await freshProjectDir();
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));

		const first = await service.dispatch("workspace.registerPath", { path: projectDir });
		const second = await service.dispatch("workspace.registerPath", { path: projectDir });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.workspaceId).toBe(first.workspaceId);
	});

	it("the derived workspaceId is stable across a daemon restart", async () => {
		const projectDir = await freshProjectDir();
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanupFns.push(cleanupPaths);

		const firstDaemon = startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
		const firstService = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));
		const beforeRestart = await firstService.dispatch("workspace.registerPath", { path: projectDir });
		await firstDaemon.stop();

		// A brand-new service instance (the daemon-kit equivalent of "the process restarted"):
		// nothing about deriveWorkspaceId depends on in-memory state from the prior instance.
		const secondService = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));
		const afterRestart = await secondService.dispatch("workspace.registerPath", { path: projectDir });

		expect(afterRestart.workspaceId).toBe(beforeRestart.workspaceId);
	});

	it("rejects a path that does not exist", async () => {
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));
		await expect(service.dispatch("workspace.registerPath", { path: "/does/not/exist/at/all" })).rejects.toBeInstanceOf(
			InvalidWorkspaceRoot,
		);
	});

	it("rejects a path that is a file, not a directory", async () => {
		const projectDir = await freshProjectDir();
		const filePath = join(projectDir, "not-a-directory.txt");
		await writeFile(filePath, "hello");
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));

		await expect(service.dispatch("workspace.registerPath", { path: filePath })).rejects.toBeInstanceOf(InvalidWorkspaceRoot);
	});

	it("a dynamically registered workspace is immediately usable by rawRead/exactEdit over the real daemon", async () => {
		const projectDir = await freshProjectDir();
		await writeFile(join(projectDir, "existing.txt"), "already on disk");
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanupFns.push(cleanupPaths);
		const daemon = startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
		cleanupFns.push(() => daemon.stop());

		const token = readFileSync(paths.token, "utf8").trim();
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(
			`http://${daemon.host}:${daemon.port}`,
			token,
			{ label: "Lector" },
		);

		const { workspaceId } = await client.call("workspace.registerPath", { path: projectDir });
		const read = await client.call("workspace.rawRead", { workspaceId, path: "existing.txt" });
		expect(read.content).toBe("already on disk");

		const edit = await client.call("workspace.exactEdit", {
			workspaceId,
			path: "new-from-lector.txt",
			expectedHash: null,
			content: "written through a dynamically registered workspace",
		});
		expect(edit.newHash).toBeTruthy();
	});
});
