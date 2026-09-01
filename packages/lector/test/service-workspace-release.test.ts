/**
 * Service-level wiring for workspace.release -- the missing counterpart to
 * workspace.registerPath that lets a temporary, fetched, or package-source workspace actually
 * leave the registry within the same daemon lifetime that created it. repo.fetch/package.resolveSource's
 * own end-to-end unblocking is covered directly in test/service-repo-fetch.test.ts and
 * test/service-package-source-lifecycle.test.ts; this file covers workspace.release itself and
 * its three distinct refusal conditions.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClosableSymbolIndex } from "../src/service/warm-index-registry.ts";
import { createLectorService, type LectorService, UnknownWorkspace, WorkspaceReleaseBlocked } from "../src/service.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function buildRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-workspace-release-"));
	writeFileSync(join(dir, "index.ts"), "export const value = 1;\n");
	return dir;
}

describe("createLectorService's workspace.release", () => {
	it("rejects an unknown workspaceId", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.release", { workspaceId: "never-registered" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("removes the registration; a later workspace.registerPath for the same path re-creates it", async () => {
		root = buildRoot();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const first = await service.dispatch("workspace.registerPath", { path: root });

		const released = await service.dispatch("workspace.release", { workspaceId: first.workspaceId });
		expect(released).toEqual({ workspaceId: first.workspaceId, closedIndexes: 0, closedGraph: false, closedWatch: false });

		await expect(service.dispatch("workspace.rawRead", { workspaceId: first.workspaceId, path: "index.ts" })).rejects.toBeInstanceOf(UnknownWorkspace);
		const second = await service.dispatch("workspace.registerPath", { path: root });
		expect(second).toEqual({ workspaceId: first.workspaceId, created: true }); // deterministic id, real re-creation
	});

	it("refuses (active-watch) while a workspace.watch registration is still active, then succeeds after workspace.unwatch", async () => {
		root = buildRoot();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const { watchId } = await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });

		const blocked = await service.dispatch("workspace.release", { workspaceId }).catch((error: unknown) => error);
		expect(blocked).toBeInstanceOf(WorkspaceReleaseBlocked);
		expect((blocked as WorkspaceReleaseBlocked).reason).toBe("active-watch");

		await service.dispatch("workspace.unwatch", { watchId });
		await expect(service.dispatch("workspace.release", { workspaceId })).resolves.toMatchObject({ workspaceId });
	});

	it("refuses (active-job) while graph population waits for resource admission", async () => {
		root = buildRoot();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			maxActiveSymbolIndexes: 1,
			reservedForegroundSlots: 1,
			backgroundAdmissionQueueTimeoutMs: 100,
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		let status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		for (let attempt = 0; attempt < 20 && status.status !== "waiting-for-resources"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			status = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		}
		expect(status.status).toBe("waiting-for-resources");

		const blocked = await service.dispatch("workspace.release", { workspaceId }).catch((error: unknown) => error);
		expect(blocked).toBeInstanceOf(WorkspaceReleaseBlocked);
		expect((blocked as WorkspaceReleaseBlocked).reason).toBe("active-job");

		for (let attempt = 0; attempt < 30; attempt++) {
			const snapshot = await service.dispatch("job.status", { jobId: job.id });
			if (snapshot.job.status === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await expect(service.dispatch("workspace.release", { workspaceId })).resolves.toMatchObject({ workspaceId });
	});

	it("refuses (active-lease) while a code-intelligence query still holds the warm index, then succeeds once it completes", async () => {
		root = buildRoot();
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fakeIndex: ClosableSymbolIndex = {
			provenance: TEST_SEMANTIC_PROVENANCE,
			async findSymbols() {
				await pending;
				return symbolSearchResult();
			},
			async close() {},
		};
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => fakeIndex });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const inFlight = service.dispatch("workspace.findSymbols", { workspaceId, query: "value" });

		// Give the lease a moment to actually be acquired before racing the release against it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const blocked = await service.dispatch("workspace.release", { workspaceId }).catch((error: unknown) => error);
		expect(blocked).toBeInstanceOf(WorkspaceReleaseBlocked);
		expect((blocked as WorkspaceReleaseBlocked).reason).toBe("active-lease");

		release?.();
		await inFlight;
		await expect(service.dispatch("workspace.release", { workspaceId })).resolves.toMatchObject({ workspaceId, closedIndexes: 1 });
	});
});
