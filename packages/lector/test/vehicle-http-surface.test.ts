/**
 * Phase 1 of "Adopt vehicle-client-pi in pi-lector": proves the daemon's real Vehicle wire
 * protocol (/vehicle/manifest, /vehicle/invoke) is actually reachable, additive alongside the
 * legacy /api/v1/ops endpoint -- not just an internal server-side dispatchThroughOperationRegistry
 * detail. Until this test existed, no VehicleClient anywhere could talk to the Lector daemon.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { startDaemon } from "@danypops/vehicle-server/daemon";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { buildLectorApp, startLectorDaemon } from "../src/daemon.ts";
import { createLectorService, type LectorService, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let root: string | undefined;
let service: LectorService | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

describe("Lector daemon's /vehicle/* surface (createVehicleHttpApp, additive alongside /api/v1/ops)", () => {
	it("serves a real manifest listing the operations already migrated onto VehicleRegistry", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const isolated = isolatedLectorPaths();
		const token = ensureAuthToken(isolated.paths.token, "Lector");
		const daemon = await startDaemon({
			daemonLabel: "Lector",
			handlePath: isolated.paths.handle,
			buildApp: () => buildLectorApp(service as LectorService, token),
		});
		stop = async () => {
			await daemon.stop();
			isolated.cleanup();
		};

		const vehicleClient = new RemoteVehicleClient({ baseUrl: `http://${daemon.host}:${daemon.port}`, token });
		const manifest = await vehicleClient.manifest();
		expect(manifest.name).toBe("lector");
		const names = manifest.operations.map((op) => op.name).sort();
		expect(names).toEqual(
			[
				"workspace.gitStatus",
				"workspace.gitLog",
				"workspace.gitDiff",
				"workspace.gitShowFile",
				"workspace.gitGrep",
				"workspace.gitGrepHistory",
				"workspace.gitListFiles",
				"workspace.gitIsAncestor",
				"workspace.gitWorktreeAdd",
				"workspace.gitWorktreeRemove",
				"repo.fetch",
				"repo.listCache",
				"repo.evictCache",
				"workspace.mutationHistory",
				"workspace.revertMutation",
				"workspace.mutationTransaction",
				"workspace.revertMutationTransaction",
				"workspace.createAnnotation",
				"workspace.getAnnotation",
				"workspace.listAnnotations",
				"workspace.refreshAnnotation",
				"workspace.scrubAnnotation",
				"workspace.restoreAnnotation",
				"workspace.containAnnotation",
				"workspace.uncontainAnnotation",
				"workspace.annotationTree",
				"workspace.previewCodeActions",
				"workspace.applyCodeAction",
				"search.githubRepos",
				"search.npmPackages",
				"search.sourcegraphCode",
			].sort(),
		);
	});

	it("invokes a real git operation over /vehicle/invoke, identically to the legacy /api/v1/ops result", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-vehicle-http-git-"));
		git(root, "init", "-q");
		git(root, "config", "user.email", "t@t.com");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, "a.txt"), "hello\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-q", "-m", "initial commit");

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const observedAuthority: unknown[] = [];
		service.operationRegistry.useExecutionMiddleware({
			id: "observe-http-authority",
			async intercept(request, next) {
				observedAuthority.push({ permissions: request.permissions, principal: request.principal });
				return next(request.input);
			},
		});
		const isolated = isolatedLectorPaths();
		const token = ensureAuthToken(isolated.paths.token, "Lector");
		const daemon = await startDaemon({
			daemonLabel: "Lector",
			handlePath: isolated.paths.handle,
			buildApp: () => buildLectorApp(service as LectorService, token),
		});
		stop = async () => {
			await daemon.stop();
			isolated.cleanup();
		};

		const legacyClient = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});
		const { workspaceId } = await legacyClient.call("workspace.registerPath", { path: root });
		const legacyResult = await legacyClient.call("workspace.gitLog", { workspaceId, maxCount: 10 });

		const vehicleClient = new RemoteVehicleClient({ baseUrl: `http://${daemon.host}:${daemon.port}`, token });
		const vehicleResult = (await vehicleClient.invoke(
			"workspace.gitLog",
			1,
			{ workspaceId, maxCount: 10 },
			{ permissions: ["forged:grant"], principal: { id: "forged-client" } },
		)) as typeof legacyResult;
		expect(vehicleResult).toEqual(legacyResult);
		expect(vehicleResult.entries[0]?.message).toBe("initial commit");
		expect(observedAuthority).toEqual([
			{ permissions: ["workspace:read"], principal: undefined },
			{
				permissions: ["workspace:read", "workspace:write", "external-search:read"],
				principal: { id: "lector-authenticated-client" },
			},
		]);

		// /api/v1/ops keeps working entirely unchanged for a non-migrated operation too --
		// this endpoint addition is purely additive, no existing behavior moved.
		const status = await legacyClient.call("workspace.gitStatus", { workspaceId });
		expect(status.files).toEqual([]);
	});

	it("metrics.query/metrics.recordClientEvent are live on the real manifest (startLectorDaemon's own wiring, not buildLectorApp directly) and record a real invocation", async () => {
		const isolated = isolatedLectorPaths();
		root = isolated.root;
		const daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		stop = async () => {
			await daemon.stop();
		};

		const token = ensureAuthToken(isolated.paths.token, "Lector");
		const vehicleClient = new RemoteVehicleClient({ baseUrl: `http://${daemon.host}:${daemon.port}`, token });

		const manifest = await vehicleClient.manifest();
		const names = manifest.operations.map((op) => op.name);
		expect(names).toContain("metrics.query");
		expect(names).toContain("metrics.recordClientEvent");

		await vehicleClient.invoke("repo.listCache", 1, { maxResults: 10 }, { permissions: ["workspace:read"] });

		const rows = (await vehicleClient.invoke("metrics.query", 1, { toolName: "repo.listCache" }, { permissions: [] })) as { count: number }[];
		expect(rows[0]?.count).toBe(1);
	});
});
