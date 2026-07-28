/**
 * Dynamic path-based workspace registration: a host adapter (pi-lector)
 * knows only "the cwd Pi is running in", not a pre-declared workspaceId, so
 * it needs a way to turn a real directory into a registered workspace at
 * runtime rather than requiring `lector serve` to have known about every
 * project upfront.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import {
	createLectorService,
	InvalidWorkspaceRoot,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	RelativeWorkspacePath,
} from "../src/service.ts";
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

		const firstDaemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
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
		await expect(service.dispatch("workspace.registerPath", { path: "/does/not/exist/at/all" })).rejects.toBeInstanceOf(InvalidWorkspaceRoot);
	});

	it("rejects a path that is a file, not a directory", async () => {
		const projectDir = await freshProjectDir();
		const filePath = join(projectDir, "not-a-directory.txt");
		await writeFile(filePath, "hello");
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));

		await expect(service.dispatch("workspace.registerPath", { path: filePath })).rejects.toBeInstanceOf(InvalidWorkspaceRoot);
	});

	it("rejects a relative path outright, rather than silently resolving it against the daemon's own process cwd", async () => {
		// Real, previously-shipped bug this fixes: a daemon has no meaningful "current directory"
		// of its own relative to any caller -- resolve(".") inside the daemon process silently
		// registered the daemon's own cwd (e.g. a systemd unit's WorkingDirectory) instead of
		// whatever directory the CLI-invoking shell actually meant.
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));

		await expect(service.dispatch("workspace.registerPath", { path: "." })).rejects.toBeInstanceOf(RelativeWorkspacePath);
		await expect(service.dispatch("workspace.registerPath", { path: "relative/dir" })).rejects.toBeInstanceOf(RelativeWorkspacePath);
	});

	it("a relative path is rejected before any filesystem access, distinct from a real-but-relative path's own existence", async () => {
		const service = createLectorService(new Map([["bootstrap", new InMemoryWorkspace()]]));
		// Deliberately a directory that genuinely exists relative to this test's own cwd (the repo
		// root) -- if the rejection only worked by accident (e.g. the path just didn't exist), this
		// case would slip through as InvalidWorkspaceRoot instead of the real RelativeWorkspacePath.
		await expect(service.dispatch("workspace.registerPath", { path: "src" })).rejects.toBeInstanceOf(RelativeWorkspacePath);
	});

	it("a dynamically registered workspace is immediately usable by rawRead/exactEdit over the real daemon", async () => {
		const projectDir = await freshProjectDir();
		await writeFile(join(projectDir, "existing.txt"), "already on disk");
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanupFns.push(cleanupPaths);
		const daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
		cleanupFns.push(() => daemon.stop());

		const token = readFileSync(paths.token, "utf8").trim();
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});

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

	it("a daemon started with zero pre-registered workspaces (allowDynamicOnly) still rejects an unregistered id, and still becomes usable once registered -- the mode pi-lector's background daemon actually runs in", async () => {
		const projectDir = await freshProjectDir();
		await writeFile(join(projectDir, "existing.txt"), "already on disk");
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanupFns.push(cleanupPaths);
		const daemon = await startLectorDaemon({ workspaces: new Map(), paths, allowDynamicOnly: true });
		cleanupFns.push(() => daemon.stop());

		const token = readFileSync(paths.token, "utf8").trim();
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});

		// No implicit fallback reappears just because the registry started empty: an id nobody
		// registered still fails loudly, exactly as it would with any statically-seeded registry.
		await expect(client.call("workspace.rawRead", { workspaceId: "never-registered", path: "existing.txt" })).rejects.toThrow(/UnknownWorkspace/);

		const { workspaceId } = await client.call("workspace.registerPath", { path: projectDir });
		const read = await client.call("workspace.rawRead", { workspaceId, path: "existing.txt" });
		expect(read.content).toBe("already on disk");
	});
});
