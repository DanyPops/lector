import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageServerDescriptor } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageServerProcess } from "../../src/code-intelligence/lsp/language-server-process.ts";
import type { CodeIntelligencePort } from "../../src/code-intelligence/port.ts";
import type { FileChangeEvent } from "../../src/file-watcher/file-change-event.ts";
import { type ClosableSymbolIndex, WarmIndexCapacityExceeded, WarmIndexRegistry } from "../../src/service/warm-index-registry.ts";

const EVIL_SERVER_PATH = fileURLToPath(new URL("../support/evil-lsp-server.ts", import.meta.url));

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

		const first = await registry.leaseWarmIndex({ workspaceId: "workspace-a", path: "src/index.ts" });
		now = 150;
		await first[Symbol.asyncDispose]();
		const second = await registry.leaseWarmIndex({ workspaceId: "workspace-a", path: "src/index.ts" });
		expect(second.value.index).toBe(first.value.index);
		expect(creates).toBe(1);
		await second[Symbol.asyncDispose]();

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
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (root, descriptor) => fakeIndex(descriptor.languageId, closed, root.endsWith("a") ? changesA : changesB),
		});
		const leaseA = await registry.leaseWarmIndex({ workspaceId: "workspace-a", path: "src/index.ts" });
		const leaseB = await registry.leaseWarmIndex({ workspaceId: "workspace-b", path: "src/index.ts" });
		await leaseA[Symbol.asyncDispose]();
		await leaseB[Symbol.asyncDispose]();
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

		await using lease = await registry.leaseWorkspaceIndex("workspace-a", "src/index.ts");
		expect(lease.value.descriptors).toEqual([TYPESCRIPT]);
		expect(seedFile).toBe("src/index.ts");
		expect(registry.sourceExtensions(lease.value.descriptors)).toEqual([".ts"]);
		rmSync(root, { recursive: true, force: true });
	});

	it("evicts the least-recently-used idle index before admitting past capacity", async () => {
		let now = 1;
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (root) => fakeIndex(root, closed, []),
			now: () => now,
			maxActive: 2,
			languageLimits: { typescript: 2 },
		});
		const first = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
		await first[Symbol.asyncDispose]();
		now = 2;
		const second = await registry.leaseWarmIndex({ workspaceId: "b", path: "b.ts" });
		await second[Symbol.asyncDispose]();
		now = 3;
		await using _third = await registry.leaseWarmIndex({ workspaceId: "c", path: "c.ts" });

		expect(closed).toEqual(["/a"]);
		expect(registry.status()).toEqual({ active: 2, leased: 1, maxActive: 2, byLanguage: { typescript: 2 } });
	});

	it("never evicts an active lease", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (root) => fakeIndex(root, closed, []),
			maxActive: 1,
			languageLimits: { typescript: 1 },
		});
		await using _active = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });

		await expect(registry.leaseWarmIndex({ workspaceId: "b", path: "b.ts" })).rejects.toBeInstanceOf(WarmIndexCapacityExceeded);
		expect(closed).toEqual([]);
		expect(registry.status().active).toBe(1);
	});

	it("replaces a dead idle index instead of reusing it", async () => {
		let creates = 0;
		let firstAlive = true;
		const closed: string[] = [];
		const events: unknown[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/workspace",
			createIndex: () => {
				creates++;
				const index = fakeIndex(`index-${creates}`, closed, []);
				return { ...index, isAlive: () => creates > 1 || firstAlive };
			},
			observe: (event) => events.push(event),
		});
		const first = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
		await first[Symbol.asyncDispose]();
		firstAlive = false;
		await using replacement = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });

		expect(replacement.value.index).not.toBe(first.value.index);
		expect(creates).toBe(2);
		expect(closed).toEqual(["index-1"]);
		expect(events).toEqual([{ kind: "dead-replaced", languageId: "typescript" }]);
	});

	it("eviction stops a real language-server process before replacement", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-warm-index-process-"));
		const roots = { a: join(root, "a"), b: join(root, "b") };
		mkdirSync(roots.a);
		mkdirSync(roots.b);
		let firstTempDirectory: string | undefined;
		const processes: LanguageServerProcess[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId: keyof typeof roots) => roots[workspaceId],
			maxActive: 1,
			languageLimits: { typescript: 1 },
			createIndex: (cwd) => {
				const process = LanguageServerProcess.spawnProcess({
					command: "bun",
					args: [EVIL_SERVER_PATH],
					cwd,
					env: { EVIL_LSP_MODE: "reports-temp-directory" },
				});
				processes.push(process);
				return {
					provenance: fakeIndex("typescript", [], []).provenance,
					async findSymbols() {
						const initialized = await process.request<{ tempDirectory: string }>("initialize", {});
						firstTempDirectory ??= initialized.tempDirectory;
						return { symbols: [], truncated: false, provenance: this.provenance };
					},
					close: () => process.stop(),
				};
			},
		});
		try {
			const first = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
			await first.value.index.findSymbols("anything");
			await first[Symbol.asyncDispose]();
			expect(firstTempDirectory).toBeDefined();
			expect(existsSync(firstTempDirectory ?? "")).toBe(true);

			await using _replacement = await registry.leaseWarmIndex({ workspaceId: "b", path: "b.ts" });
			expect(existsSync(firstTempDirectory ?? "")).toBe(false);
		} finally {
			await registry.closeAll();
			await Promise.all(processes.map((process) => process.stop()));
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a failed idle reap and reports path-free telemetry", async () => {
		let now = 0;
		const events: unknown[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/secret/workspace",
			createIndex: () => ({
				...fakeIndex("typescript", [], []),
				close: () => Promise.reject(new TypeError("private path: /secret/workspace")),
			}),
			now: () => now,
			observe: (event) => events.push(event),
		});
		const lease = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
		await lease[Symbol.asyncDispose]();
		now = 2;

		expect(await registry.reapIdle(1)).toBe(0);
		expect(registry.status().active).toBe(1);
		expect(events).toEqual([{ kind: "close-failed", reason: "idle-reap", languageId: "typescript", errorName: "TypeError" }]);
		expect(JSON.stringify(events)).not.toContain("/secret/workspace");
	});

	it("measures idle time from lease completion", async () => {
		let now = 100;
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: () => "/workspace",
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed, []),
			now: () => now,
		});
		const lease = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
		now = 1_000;
		expect(await registry.reapIdle(10)).toBe(0);
		await lease[Symbol.asyncDispose]();
		now = 1_009;
		expect(await registry.reapIdle(10)).toBe(0);
		now = 1_011;
		expect(await registry.reapIdle(10)).toBe(1);
		expect(closed).toEqual(["typescript"]);
	});
});
