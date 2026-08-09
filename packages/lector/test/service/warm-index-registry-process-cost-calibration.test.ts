import { describe, expect, it } from "bun:test";
import type { LanguageServerDescriptor } from "../../src/code-intelligence/language-server-descriptor.ts";
import { type ClosableSymbolIndex, WarmIndexRegistry } from "../../src/service/warm-index-registry.ts";

const TYPESCRIPT: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "typescript-fixture",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: "fixture" },
	args: [],
	rootMarkers: ["tsconfig.json"],
	commonSeedCandidates: ["src/index.ts"],
};

const GO: LanguageServerDescriptor = {
	languageId: "go",
	backendId: "go-fixture",
	extensions: [".go"],
	launch: { kind: "system-binary", command: "fixture" },
	args: [],
	rootMarkers: ["go.mod"],
	commonSeedCandidates: ["main.go"],
};

function fakeIndex(languageId: string, processId?: number): ClosableSymbolIndex {
	return {
		provenance: {
			fidelity: "semantic",
			backend: `${languageId}-fixture`,
			languageId,
			authority: "language-server",
			freshness: "live-process",
			limitations: [],
		},
		processId,
		async findSymbols() {
			return { symbols: [], truncated: false, provenance: this.provenance };
		},
		async close() {},
	};
}

describe("WarmIndexRegistry.calibrateProcessCosts", () => {
	it("is a safe no-op without a configured calibrator", async () => {
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/workspace",
			createIndex: () => fakeIndex("typescript", 4242),
		});
		await registry.leaseWarmIndex({ workspaceId: "a", path: "index.ts" });

		expect(() => registry.calibrateProcessCosts()).not.toThrow();
	});

	it("samples every active entry with a real processId, keyed by that entry's own language", async () => {
		const samples: Array<{ languageId: string; pid: number }> = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT, GO],
			resolveRoot: (workspaceId: string) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, descriptor.languageId === "typescript" ? 1001 : 2002),
			maxActive: 4,
			processCostCalibrator: { recordSample: (languageId, pid) => samples.push({ languageId, pid }) },
		});
		await registry.leaseWarmIndex({ workspaceId: "a", path: "index.ts" });
		await registry.leaseWarmIndex({ workspaceId: "b", path: "main.go" });

		registry.calibrateProcessCosts();

		expect(samples).toHaveLength(2);
		expect(samples).toContainEqual({ languageId: "typescript", pid: 1001 });
		expect(samples).toContainEqual({ languageId: "go", pid: 2002 });
	});

	it("skips an entry with no processId (a backend with no subprocess of its own), without error", async () => {
		const samples: Array<{ languageId: string; pid: number }> = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/workspace",
			createIndex: () => fakeIndex("typescript", undefined),
			processCostCalibrator: { recordSample: (languageId, pid) => samples.push({ languageId, pid }) },
		});
		await registry.leaseWarmIndex({ workspaceId: "a", path: "index.ts" });

		registry.calibrateProcessCosts();

		expect(samples).toEqual([]);
	});

	it("never samples an evicted/closed entry -- only what is currently active", async () => {
		const samples: Array<{ languageId: string; pid: number }> = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId: string) => `/${workspaceId}`,
			createIndex: () => fakeIndex("typescript", 4242),
			processCostCalibrator: { recordSample: (languageId, pid) => samples.push({ languageId, pid }) },
		});
		const lease = await registry.leaseWarmIndex({ workspaceId: "a", path: "index.ts" });
		await lease[Symbol.asyncDispose]();
		await registry.releaseWorkspaceIfIdle("a");

		registry.calibrateProcessCosts();

		expect(samples).toEqual([]);
	});
});
