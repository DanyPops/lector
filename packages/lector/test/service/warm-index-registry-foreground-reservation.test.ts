/**
 * The starvation fix: a background admission (populateSymbolGraph) must never be able to grow
 * the warm-index pool past reservedForegroundSlots' reduced ceiling, and must queue (bounded,
 * cancellable) rather than either blocking the shared admission lock or hard-failing instantly.
 * Foreground admission is never subject to the reduced ceiling or the queue at all -- the live
 * regression this fixes was foreground work getting WarmIndexCapacityExceeded while background
 * jobs held every slot.
 */
import { describe, expect, it } from "bun:test";
import type { LanguageServerDescriptor } from "../../src/code-intelligence/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../../src/code-intelligence/port.ts";
import {
	type ClosableSymbolIndex,
	WarmIndexAdmissionQueueFull,
	WarmIndexAdmissionQueueTimedOut,
	WarmIndexRegistry,
} from "../../src/service/warm-index-registry.ts";

const TYPESCRIPT: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "typescript-fixture",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: "fixture" },
	args: [],
	rootMarkers: ["tsconfig.json"],
	commonSeedCandidates: ["src/index.ts"],
};

function fakeIndex(languageId: string, closed: string[]): ClosableSymbolIndex & Pick<CodeIntelligencePort, "goToDefinition"> {
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
	};
}

function elapsedMs(startedAt: number): number {
	return Date.now() - startedAt;
}

describe("WarmIndexRegistry foreground reservation", () => {
	it("caps background admission below maxActive while foreground keeps using the full capacity", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed),
			maxActive: 2,
			reservedForegroundSlots: 1,
			backgroundAdmissionQueueTimeoutMs: 40,
		});

		// Background admits one workspace, filling its own reduced ceiling of 1.
		const background = await registry.leaseWarmIndex({ workspaceId: "bg-a", path: "src/index.ts", workKind: "background" });

		// A second, different-workspace background admission has no idle victim to evict (the
		// only entry is actively leased) and cannot exceed its own reduced ceiling -- it must
		// queue and time out, never silently steal the reserved slot.
		await expect(registry.leaseWarmIndex({ workspaceId: "bg-b", path: "src/index.ts", workKind: "background" })).rejects.toBeInstanceOf(
			WarmIndexAdmissionQueueTimedOut,
		);

		// Foreground, by contrast, still has the full maxActive=2 available and is never queued.
		await using foreground = await registry.leaseWarmIndex({ workspaceId: "fg-a", path: "src/index.ts" });
		expect(foreground.value.index).toBeDefined();
		expect(registry.status().active).toBe(2);

		await background[Symbol.asyncDispose]();
	});

	it("admits a queued background request promptly once the reserved-adjacent slot actually frees, instead of waiting out the full timeout", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed),
			maxActive: 1,
			reservedForegroundSlots: 0,
			backgroundAdmissionQueueTimeoutMs: 2_000,
		});

		const first = await registry.leaseWarmIndex({ workspaceId: "bg-a", path: "src/index.ts", workKind: "background" });
		const startedAt = Date.now();
		const queued = registry.leaseWarmIndex({ workspaceId: "bg-b", path: "src/index.ts", workKind: "background" });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(registry.waitingForAdmission("bg-b")).toBe(true);
		await first[Symbol.asyncDispose]();

		await using second = await queued;
		expect(second.value.index).toBeDefined();
		expect(elapsedMs(startedAt)).toBeLessThan(1_000); // woke on release, not the 2s timeout
		expect(registry.waitingForAdmission("bg-b")).toBe(false);
	});

	it("fails fast with WarmIndexAdmissionQueueFull once the wait queue itself is at capacity, rather than growing it further", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed),
			maxActive: 1,
			reservedForegroundSlots: 0,
			backgroundAdmissionQueueTimeoutMs: 200,
			maxQueuedBackgroundAdmissions: 1,
		});

		await using held = await registry.leaseWarmIndex({ workspaceId: "bg-a", path: "src/index.ts", workKind: "background" });
		expect(held.value.index).toBeDefined();
		const firstQueued = registry.leaseWarmIndex({ workspaceId: "bg-b", path: "src/index.ts", workKind: "background" });
		await new Promise((resolve) => setTimeout(resolve, 10)); // let firstQueued actually enter the wait

		await expect(registry.leaseWarmIndex({ workspaceId: "bg-c", path: "src/index.ts", workKind: "background" })).rejects.toBeInstanceOf(
			WarmIndexAdmissionQueueFull,
		);

		await expect(firstQueued).rejects.toBeInstanceOf(WarmIndexAdmissionQueueTimedOut);
	});

	it("reports waitingBackgroundAdmissions in pool status while a background request is queued", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed),
			maxActive: 1,
			backgroundAdmissionQueueTimeoutMs: 60,
		});

		await using held = await registry.leaseWarmIndex({ workspaceId: "bg-a", path: "src/index.ts", workKind: "background" });
		expect(held.value.index).toBeDefined();
		expect(registry.status().waitingBackgroundAdmissions).toBe(0);
		const queued = registry.leaseWarmIndex({ workspaceId: "bg-b", path: "src/index.ts", workKind: "background" });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(registry.status().waitingBackgroundAdmissions).toBe(1);
		await expect(queued).rejects.toBeInstanceOf(WarmIndexAdmissionQueueTimedOut);
		expect(registry.status().waitingBackgroundAdmissions).toBe(0);
	});

	it("never queues foreground admission even while background waits at the same reduced ceiling", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed),
			maxActive: 3,
			languageLimits: { typescript: 3 }, // isolate the global reservation from TypeScript's own default per-language cap of 2
			reservedForegroundSlots: 1,
			backgroundAdmissionQueueTimeoutMs: 2_000,
		});

		// Fill the reduced background ceiling (maxActive - reserved = 2) with two active background leases.
		const bg1 = await registry.leaseWarmIndex({ workspaceId: "bg-1", path: "src/index.ts", workKind: "background" });
		const bg2 = await registry.leaseWarmIndex({ workspaceId: "bg-2", path: "src/index.ts", workKind: "background" });
		// A third background admission has nothing idle to evict and is at its own ceiling -- queues.
		const bg3 = registry.leaseWarmIndex({ workspaceId: "bg-3", path: "src/index.ts", workKind: "background" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(registry.waitingForAdmission("bg-3")).toBe(true);

		// Foreground still has real room up to the full maxActive=3 and must not be made to wait.
		const startedAt = Date.now();
		await using foreground = await registry.leaseWarmIndex({ workspaceId: "fg-1", path: "src/index.ts" });
		expect(foreground.value.index).toBeDefined();
		expect(elapsedMs(startedAt)).toBeLessThan(200);

		// Releasing either background lease frees the room bg3 was queued for -- it wakes and
		// admits well inside its own 2s timeout, proving the queue actually drains rather than
		// only ever timing out.
		await Promise.all([bg1[Symbol.asyncDispose](), bg2[Symbol.asyncDispose]()]);
		await using resolvedBg3 = await bg3;
		expect(resolvedBg3.value.index).toBeDefined();
	});

	it("preserves today's exact behavior when reservedForegroundSlots is left at its default of 0", async () => {
		const closed: string[] = [];
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId) => `/${workspaceId}`,
			createIndex: (_root, descriptor) => fakeIndex(descriptor.languageId, closed),
			maxActive: 1,
		});

		await using bg = await registry.leaseWarmIndex({ workspaceId: "bg-a", path: "src/index.ts", workKind: "background" });
		expect(bg.value.index).toBeDefined();
		expect(registry.status()).toMatchObject({ active: 1, maxActive: 1, waitingBackgroundAdmissions: 0 });
	});
});
