import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import type { WarmIndexResourceSnapshot, WarmIndexResourceSnapshotPort } from "../src/code-intelligence/warm-index-resource-policy.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/service.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

class MutableResources implements WarmIndexResourceSnapshotPort {
	constructor(private value: WarmIndexResourceSnapshot) {}
	current(): WarmIndexResourceSnapshot {
		return this.value;
	}
	set(value: WarmIndexResourceSnapshot): void {
		this.value = value;
	}
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

describe("daemon adaptive warm-index resource wiring", () => {
	it("contracts and expands admissions from the injected production snapshot seam", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-adaptive-daemon-"));
		const createProject = (name: string): string => {
			const project = join(root, name);
			mkdirSync(join(project, "src"), { recursive: true });
			writeFileSync(join(project, "tsconfig.json"), "{}\n");
			writeFileSync(join(project, "src", "index.ts"), `export const ${name} = 1;\n`);
			return project;
		};
		const projectA = createProject("a");
		const projectB = createProject("b");
		const projectC = createProject("c");
		const projectD = createProject("d");
		const projectRoots = [projectA, projectB, projectC, projectD];
		const resources = new MutableResources({ indexMemoryBudgetBytes: 200, pressure: "low" });
		const closed: string[] = [];
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const daemon = await startLectorDaemon({
			workspaces: new Map(),
			allowDynamicOnly: true,
			paths,
			createSymbolIndexResourceSnapshot: () => resources,
			symbolIndexEstimatedBytesByLanguage: { typescript: 100 },
			symbolIndexDefaultEstimatedBytes: 100,
			createSymbolIndex: (project) => ({
				provenance: TEST_SEMANTIC_PROVENANCE,
				findSymbols: async () => symbolSearchResult(),
				close: async () => {
					closed.push(project);
				},
			}),
		});
		cleanup = async () => {
			await daemon.stop();
			cleanupPaths();
			rmSync(root, { recursive: true, force: true });
		};
		const token = ensureAuthToken(paths.token, "Lector");
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});
		const workspaceIds: string[] = [];
		for (const project of projectRoots) workspaceIds.push((await client.call("workspace.registerPath", { path: project })).workspaceId);
		const query = (workspaceId: string) => client.call("workspace.findSymbols", { workspaceId, query: "value" });

		await query(workspaceIds[0] ?? "");
		await query(workspaceIds[1] ?? "");
		await query(workspaceIds[2] ?? "");
		expect(closed).toEqual([projectA]);

		resources.set({ indexMemoryBudgetBytes: 300, pressure: "low" });
		await query(workspaceIds[3] ?? "");
		expect(closed).toHaveLength(1);

		resources.set({ indexMemoryBudgetBytes: 100, pressure: "low" });
		await query(workspaceIds[1] ?? "");
		expect(new Set(closed)).toEqual(new Set([projectA, projectC, projectD]));
	});
});
