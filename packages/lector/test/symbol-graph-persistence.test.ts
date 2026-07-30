/**
 * The real gap this closes: createLectorService's default createSymbolGraph
 * is in-memory (by design -- tests want that), but the real daemon
 * (startLectorDaemon/serveMain) was never wired to override it, so every
 * populateSymbolGraph pass was silently lost on restart. This proves the
 * daemon-level wiring survives a real stop/start cycle, the same way
 * workspace-register-path.test.ts proves workspaceId derivation does.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { startLectorDaemon } from "../src/daemon.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanupFns: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanupFns.reverse()) await fn();
	cleanupFns = [];
});

function client(daemon: { host: string; port: number }, token: string) {
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, { label: "Lector" });
}

describe("symbol graph persistence across a real daemon restart", () => {
	it("a graph populated before a restart is still queryable by a fresh daemon process pointed at the same paths", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "lector-graph-persistence-"));
		cleanupFns.push(() => rm(projectDir, { recursive: true, force: true }));
		await writeFile(join(projectDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		const chainFile = join(projectDir, "chain.ts");
		await writeFile(chainFile, "export function outer(): number {\n\treturn inner();\n}\n\nexport function inner(): number {\n\treturn 1;\n}\n");

		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanupFns.push(cleanupPaths);

		const firstDaemon = await startLectorDaemon({ workspaces: new Map(), paths, allowDynamicOnly: true });
		const token = readFileSync(paths.token, "utf8").trim();
		const firstClient = client(firstDaemon, token);

		const { workspaceId } = await firstClient.call("workspace.registerPath", { path: projectDir });
		const populateResult = await firstClient.call("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 50 });
		expect(populateResult.edgesAdded).toBeGreaterThan(0);

		const beforeRestart = await firstClient.call("workspace.reachableFrom", { workspaceId, path: chainFile, line: 1, character: 17, maxDepth: 2 });
		expect(beforeRestart.symbols.map((s) => s.name)).toContain("inner");
		expect((await firstClient.call("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 50 })).status).toBe("cached");

		await firstDaemon.stop();

		// A brand-new daemon process pointed at the identical paths -- the real shape of a
		// systemd restart, not just a new in-process service instance sharing JS heap state.
		const secondDaemon = await startLectorDaemon({ workspaces: new Map(), paths, allowDynamicOnly: true });
		cleanupFns.push(() => secondDaemon.stop());
		const secondClient = client(secondDaemon, token);

		// Same absolute path always derives the same workspaceId (deterministic hash) --
		// registerPath again rather than assuming a workspace registration itself persists
		// (it doesn't, by design: only the graph data underneath it does).
		const { workspaceId: workspaceIdAfterRestart } = await secondClient.call("workspace.registerPath", { path: projectDir });
		expect(workspaceIdAfterRestart).toBe(workspaceId);

		const afterRestart = await secondClient.call("workspace.reachableFrom", {
			workspaceId: workspaceIdAfterRestart,
			path: chainFile,
			line: 1,
			character: 17,
			maxDepth: 2,
		});
		expect(afterRestart.symbols.map((s) => s.name)).toContain("inner");
		expect((await secondClient.call("workspace.cacheStatus", { workspaceId: workspaceIdAfterRestart, maxFiles: 10, maxSymbolsPerFile: 50 })).status).toBe(
			"cached",
		);
	}, 30_000);
});
