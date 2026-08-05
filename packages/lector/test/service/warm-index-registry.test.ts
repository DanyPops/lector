import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageServerDescriptor } from "../../src/code-intelligence/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../../src/code-intelligence/port.ts";
import type { FileChangeEvent } from "../../src/file-watcher/file-change-event.ts";
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

function fakeIndex(
	languageId: string,
	closed: string[],
	changes: FileChangeEvent[],
): ClosableSymbolIndex & Pick<CodeIntelligencePort, "goToDefinition" | "notifyFileChanged"> {
	return {
		provenance: {
			fidelity: "semantic",
			backend: `${languageId}-fixture`,
			languageId,
			authority: "language-server",
			freshness: "live-process",
			limitations: [],
		},
		async findSymbols() {
			return { symbols: [], truncated: false, provenance: this.provenance };
		},
		async close() {
			closed.push(languageId);
		},
		async goToDefinition() {
			return [];
		},
		notifyFileChanged(event) {
			changes.push(event);
		},
	};
}

describe("WarmIndexRegistry", () => {
	it("reuses one index per workspace/language and refreshes its idle timestamp", async () => {
		let now = 100;
		let creates = 0;
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/workspace",
			createIndex: (_root, descriptor) => {
				creates += 1;
				return fakeIndex(descriptor.languageId, closed, []);
			},
			now: () => now,
		});

		const first = registry.ensureLanguageIndex("workspace-a", "/workspace", TYPESCRIPT);
		now = 150;
		const second = registry.ensureLanguageIndex("workspace-a", "/workspace", TYPESCRIPT);
		expect(second).toBe(first);
		expect(creates).toBe(1);

		now = 225;
		expect(await registry.reapIdle(100)).toBe(0);
		now = 251;
		expect(await registry.reapIdle(100)).toBe(1);
		expect(closed).toEqual(["typescript"]);
	});

	it("keeps workspace ownership isolated for notification and close sweeps", async () => {
		const closed: string[] = [];
		const changesA: FileChangeEvent[] = [];
		const changesB: FileChangeEvent[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/workspace",
			createIndex: (root, descriptor) => fakeIndex(descriptor.languageId, closed, root.endsWith("a") ? changesA : changesB),
		});
		registry.ensureLanguageIndex("workspace-a", "/workspace-a", TYPESCRIPT);
		registry.ensureLanguageIndex("workspace-b", "/workspace-b", TYPESCRIPT);
		const event: FileChangeEvent = { path: "src/a.ts", kind: "modified" };

		registry.notifyFileChanged("workspace-a", event);
		expect(changesA).toEqual([event]);
		expect(changesB).toEqual([]);
		await registry.closeWorkspace("workspace-a");
		expect(registry.hasWarmIndex("workspace-a")).toBe(false);
		expect(registry.hasWarmIndex("workspace-b")).toBe(true);
	});

	it("discovers a workspace language, honors a preferred seed, and reports source extensions", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-warm-index-registry-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "tsconfig.json"), "{}");
		writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
		let seedFile: string | undefined;
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => root,
			createIndex: (_root, descriptor, seed) => {
				seedFile = seed;
				return fakeIndex(descriptor.languageId, [], []);
			},
		});

		const result = registry.ensureWorkspaceIndex("workspace-a", "src/index.ts");
		expect(result.descriptors).toEqual([TYPESCRIPT]);
		expect(seedFile).toBe("src/index.ts");
		expect(registry.sourceExtensions(result.descriptors)).toEqual([".ts"]);
		rmSync(root, { recursive: true, force: true });
	});
});
