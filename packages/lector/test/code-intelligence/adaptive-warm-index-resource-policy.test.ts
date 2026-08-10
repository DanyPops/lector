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

	it("raises the soft ceiling above the active count once budget genuinely allows more, using conservative worst-case cost", () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 1_000, pressure: "low" });
		const policy = new AdaptiveWarmIndexResourcePolicy({
			resources,
			estimatedBytesByLanguage: { typescript: 100, rust: 300 },
			defaultEstimatedBytes: 100,
		});

		// 2 active (typescript+rust, worst-case 300 each committed=400) leaves 600 of 1000 remaining;
		// conservative sizing uses the highest known cost (300, rust), so 600/300 = 2 more slots fit.
		expect(policy.softActiveCeiling(["typescript", "rust"])).toBe(4);
	});

	it("never reports a ceiling below the current active count, even when already over budget", () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 100, pressure: "low" });
		const policy = new AdaptiveWarmIndexResourcePolicy({
			resources,
			estimatedBytesByLanguage: { typescript: 100 },
			defaultEstimatedBytes: 100,
		});

		expect(policy.softActiveCeiling(["typescript", "typescript", "typescript"])).toBe(3);
	});

	it("fails closed (undefined) when the resource snapshot itself cannot be read", () => {
		const resources: WarmIndexResourceSnapshotPort = {
			current(): WarmIndexResourceSnapshot {
				throw new Error("cgroup read failed");
			},
		};
		const policy = new AdaptiveWarmIndexResourcePolicy({ resources, estimatedBytesByLanguage: { typescript: 100 }, defaultEstimatedBytes: 100 });

		expect(policy.softActiveCeiling(["typescript"])).toBeUndefined();
	});

	it("consults a costEstimator's own maxKnownCostBytes when one is configured, not the static baseline", () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 1_000, pressure: "low" });
		const policy = new AdaptiveWarmIndexResourcePolicy({
			resources,
			estimatedBytesByLanguage: { typescript: 100 },
			defaultEstimatedBytes: 100,
			costEstimator: { estimateBytes: () => 100, maxKnownCostBytes: () => 500 },
		});

		// committed = 100 (1 active typescript at the estimator's own 100), remaining = 900, cost = 500 -> 1 more slot.
		expect(policy.softActiveCeiling(["typescript"])).toBe(2);
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
	it("a larger memory budget actually raises real concurrent capacity past a configured maxActive that would otherwise be the bottleneck -- the live stress-test regression", async () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 300, pressure: "low" });
		const closed: string[] = [];
		const policy = new AdaptiveWarmIndexResourcePolicy({ resources, estimatedBytesByLanguage: { typescript: 100 }, defaultEstimatedBytes: 100 });
		// maxActive: 2 mirrors a conservative configured default -- the memory budget (300 bytes,
		// enough for 3 typescript indexes at 100 each) genuinely supports more.
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId: string) => `/${workspaceId}`,
			createIndex: (root) => fakeIndex(root, closed),
			maxActive: 2,
			languageLimits: { typescript: 10 },
			resourcePolicy: policy,
		});

		const first = await registry.leaseWarmIndex({ workspaceId: "a", path: "a.ts" });
		const second = await registry.leaseWarmIndex({ workspaceId: "b", path: "b.ts" });
		// Without this fix, this third lease would fail with WarmIndexCapacityExceeded purely on the
		// static maxActive=2 count check, even though the real memory budget has room for it.
		const third = await registry.leaseWarmIndex({ workspaceId: "c", path: "c.ts" });

		expect(registry.status().active).toBe(3);
		expect(registry.status().effectiveMaxActive).toBe(3);
		expect(registry.status().activeCeilingSource).toBe("resource-budget");
		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		await third[Symbol.asyncDispose]();
	});

	it("never raises the effective ceiling past absoluteMaxActiveIndexes even when the budget would allow more", async () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 100_000, pressure: "low" });
		const closed: string[] = [];
		const policy = new AdaptiveWarmIndexResourcePolicy({ resources, estimatedBytesByLanguage: { typescript: 1 }, defaultEstimatedBytes: 1 });
		const registry = new WarmIndexRegistry({
			descriptors: [TYPESCRIPT],
			resolveRoot: (workspaceId: string) => `/${workspaceId}`,
			createIndex: (root) => fakeIndex(root, closed),
			maxActive: 2,
			absoluteMaxActiveIndexes: 3,
			languageLimits: { typescript: 100 },
			resourcePolicy: policy,
		});

		const leases = [];
		for (let i = 0; i < 3; i++) leases.push(await registry.leaseWarmIndex({ workspaceId: `ws-${i}`, path: `${i}.ts` }));
		expect(registry.status().active).toBe(3);
		expect(registry.status().activeCeilingSource).toBe("absolute-cap");

		await expect(registry.leaseWarmIndex({ workspaceId: "overflow", path: "overflow.ts" })).rejects.toBeInstanceOf(WarmIndexCapacityExceeded);
		for (const lease of leases) await lease[Symbol.asyncDispose]();
	});

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

	it("uses a live costEstimator's calibrated peak over its own static estimatedBytesByLanguage once one is set", () => {
		const resources = new MutableResourceSnapshot({ indexMemoryBudgetBytes: 250, pressure: "low" });
		let calibratedBytes: number | undefined;
		const policy = new AdaptiveWarmIndexResourcePolicy({
			resources,
			estimatedBytesByLanguage: { typescript: 100 },
			defaultEstimatedBytes: 100,
			costEstimator: { estimateBytes: (languageId) => (languageId === "typescript" ? (calibratedBytes ?? 100) : 100) },
		});

		// Before calibration: static-equivalent 100 bytes per language, so a 250-byte budget
		// admits two.
		expect(policy.canAdmit(["typescript"], "typescript")).toBe(true);
		expect(policy.canAdmit(["typescript", "typescript"], "typescript")).toBe(false);

		// A real sample shows this language server actually needs far more than the static
		// guess -- admission must reflect that immediately, never underestimate it.
		calibratedBytes = 240;
		expect(policy.canAdmit([], "typescript")).toBe(true);
		expect(policy.canAdmit(["typescript"], "typescript")).toBe(false); // one already-admitted 240-byte index leaves no room for a second
	});
});
