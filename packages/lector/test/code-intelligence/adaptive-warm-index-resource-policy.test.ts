import { describe, expect, it } from "bun:test";
import type { LanguageServerDescriptor } from "../../src/code-intelligence/language-server-descriptor.ts";
import {
	AdaptiveWarmIndexResourcePolicy,
	type WarmIndexResourceSnapshot,
	type WarmIndexResourceSnapshotPort,
} from "../../src/code-intelligence/warm-index-resource-policy.ts";
import { type ClosableSymbolIndex, WarmIndexCapacityExceeded, WarmIndexRegistry } from "../../src/service/warm-index-registry.ts";

const TYPESCRIPT: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "typescript-fixture",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: "fixture" },
	args: [],
	rootMarkers: ["tsconfig.json"],
	commonSeedCandidates: ["src/index.ts"],
};

function fakeIndex(name: string, closed: string[]): ClosableSymbolIndex {
	return {
		provenance: {
			fidelity: "semantic",
			backend: "typescript-fixture",
			languageId: "typescript",
			authority: "language-server",
			freshness: "live-process",
			limitations: [],
		},
		async findSymbols() {
			return { symbols: [], truncated: false, provenance: this.provenance };
		},
		async close() {
			closed.push(name);
		},
	};
}

class MutableResourceSnapshot implements WarmIndexResourceSnapshotPort {
	constructor(private value: WarmIndexResourceSnapshot) {}

	current(): WarmIndexResourceSnapshot {
		return this.value;
	}

	set(next: WarmIndexResourceSnapshot): void {
		this.value = next;
	}
}

function createHarness(initial: WarmIndexResourceSnapshot) {
	const resources = new MutableResourceSnapshot(initial);
	let now = 0;
	const closed: string[] = [];
	const events: unknown[] = [];
	const policy = new AdaptiveWarmIndexResourcePolicy({
		resources,
		estimatedBytesByLanguage: { typescript: 100 },
		defaultEstimatedBytes: 100,
	});
	const registry = new WarmIndexRegistry({
		descriptors: [TYPESCRIPT],
		resolveRoot: (workspaceId: string) => `/${workspaceId}`,
		createIndex: (root) => fakeIndex(root, closed),
		maxActive: 6,
		languageLimits: { typescript: 6 },
		resourcePolicy: policy,
		now: () => now,
		observe: (event) => events.push(event),
	});
	return {
		registry,
		closed,
		events,
		setResources(next: WarmIndexResourceSnapshot) {
			resources.set(next);
		},
		setNow(next: number) {
			now = next;
		},
	};
}

describe("AdaptiveWarmIndexResourcePolicy", () => {
	it("grows and contracts admission from resource access", () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 200, pressure: "low" });
		const policy = new AdaptiveWarmIndexResourcePolicy({
			resources,
			estimatedBytesByLanguage: { typescript: 100 },
			defaultEstimatedBytes: 100,
		});

		expect(policy.canAdmit(["typescript"], "typescript")).toBe(true);
		expect(policy.canAdmit(["typescript", "typescript"], "typescript")).toBe(false);
		resources.set({ indexMemoryBudgetBytes: 400, pressure: "low" });
		expect(policy.canAdmit(["typescript", "typescript"], "typescript")).toBe(true);
		resources.set({ indexMemoryBudgetBytes: 400, pressure: "high" });
		expect(policy.isOverBudget(["typescript", "typescript", "typescript"])).toBe(true);
		expect(policy.status(["typescript", "typescript", "typescript"])).toEqual({
			pressure: "high",
			indexMemoryBudgetBytes: 400,
			effectiveIndexMemoryBudgetBytes: 200,
			estimatedActiveBytes: 300,
		});
	});

	it("keeps sparse healthy indexes longer and reaps pressured indexes sooner", () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 400, pressure: "low" });
		const policy = new AdaptiveWarmIndexResourcePolicy({
			resources,
			estimatedBytesByLanguage: { typescript: 100 },
			defaultEstimatedBytes: 100,
		});

		expect(policy.maxIdleMs(100, ["typescript"])).toBe(200);
		expect(policy.maxIdleMs(100, ["typescript", "typescript", "typescript"])).toBe(100);
		resources.set({ indexMemoryBudgetBytes: 400, pressure: "moderate" });
		expect(policy.maxIdleMs(100, ["typescript"])).toBe(50);
		resources.set({ indexMemoryBudgetBytes: 400, pressure: "high" });
		expect(policy.maxIdleMs(100, ["typescript"])).toBe(25);
		resources.set({ indexMemoryBudgetBytes: 400, pressure: "critical" });
		expect(policy.maxIdleMs(100, ["typescript"])).toBe(0);
	});
});

describe("adaptive warm-index resource harness", () => {
	it("raises the cap with resources and evicts only after active leases can retire", async () => {
		const harness = createHarness({ indexMemoryBudgetBytes: 200, pressure: "low" });
		const first = await harness.registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
		const second = await harness.registry.leaseWarmIndex({ workspaceId: "b", path: "b.ts" });
		await expect(harness.registry.leaseWarmIndex({ workspaceId: "c", path: "c.ts" })).rejects.toBeInstanceOf(WarmIndexCapacityExceeded);

		harness.setResources({ indexMemoryBudgetBytes: 400, pressure: "low" });
		const third = await harness.registry.leaseWarmIndex({ workspaceId: "c", path: "c.ts" });
		const fourth = await harness.registry.leaseWarmIndex({ workspaceId: "d", path: "d.ts" });
		expect(harness.registry.status().active).toBe(4);

		harness.setResources({ indexMemoryBudgetBytes: 200, pressure: "low" });
		expect(await harness.registry.reconcileResources()).toBe(0);
		expect(harness.registry.status()).toMatchObject({ active: 4, leased: 4 });
		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		expect(harness.registry.status()).toMatchObject({ active: 2, leased: 2 });
		expect(harness.closed).toEqual(["/a", "/b"]);
		expect(harness.events).toEqual([
			{ kind: "resource-pressure-evicted", languageId: "typescript" },
			{ kind: "resource-pressure-evicted", languageId: "typescript" },
		]);

		await third[Symbol.asyncDispose]();
		await fourth[Symbol.asyncDispose]();
		await harness.registry.closeAll();
	});

	it("changes idle lifespan with pressure and pool occupancy", async () => {
		const harness = createHarness({ indexMemoryBudgetBytes: 400, pressure: "low" });
		const lazy = await harness.registry.leaseWarmIndex({ workspaceId: "lazy", path: "lazy.ts" });
		await lazy[Symbol.asyncDispose]();
		harness.setNow(101);
		expect(await harness.registry.reapIdle(100)).toBe(0);
		harness.setNow(201);
		expect(await harness.registry.reapIdle(100)).toBe(1);

		const eager = await harness.registry.leaseWarmIndex({ workspaceId: "eager", path: "eager.ts" });
		await eager[Symbol.asyncDispose]();
		harness.setResources({ indexMemoryBudgetBytes: 400, pressure: "high" });
		harness.setNow(227);
		expect(await harness.registry.reapIdle(100)).toBe(1);
		expect(harness.closed).toEqual(["/lazy", "/eager"]);
	});
});
