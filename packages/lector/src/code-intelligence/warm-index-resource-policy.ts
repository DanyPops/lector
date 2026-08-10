export type WarmIndexResourcePressure = "low" | "moderate" | "high" | "critical";

export interface WarmIndexResourceSnapshot {
	/** Bytes reserved for live language-server process trees, including existing indexes. */
	readonly indexMemoryBudgetBytes: number;
	readonly pressure: WarmIndexResourcePressure;
}

export interface WarmIndexResourceSnapshotPort {
	current(): WarmIndexResourceSnapshot;
}

export interface WarmIndexAdmissionPolicy {
	canAdmit(activeLanguages: readonly string[], requestedLanguage: string): boolean;
	isOverBudget(activeLanguages: readonly string[]): boolean;
	/**
	 * A conservative, count-shaped ceiling derived from the real memory budget and worst-case known
	 * per-language cost -- lets a larger cgroup envelope actually raise how many warm indexes the
	 * registry will try to keep active, instead of a fixed configured count being the permanent
	 * bottleneck regardless of how much memory is genuinely available. Never authoritative on its
	 * own: canAdmit's own precise per-attempt byte check still gates the actual admission. Returns
	 * undefined on any metric loss (a snapshot read failure, an invalid/zero cost) -- fails closed,
	 * never treated as "unlimited room."
	 */
	softActiveCeiling(activeLanguages: readonly string[]): number | undefined;
}

export interface WarmIndexRetentionPolicy {
	maxIdleMs(configuredMaxIdleMs: number, activeLanguages: readonly string[]): number;
}

export interface WarmIndexResourceStatus {
	readonly pressure: WarmIndexResourcePressure;
	readonly indexMemoryBudgetBytes: number;
	readonly effectiveIndexMemoryBudgetBytes: number;
	readonly estimatedActiveBytes: number;
}

export interface WarmIndexResourceStatusProvider {
	status(activeLanguages: readonly string[]): WarmIndexResourceStatus;
}

export interface WarmIndexResourcePolicy extends WarmIndexAdmissionPolicy, WarmIndexRetentionPolicy, WarmIndexResourceStatusProvider {}

/** Bytes to reserve for one warm index of a language -- a live, possibly-calibrated source AdaptiveWarmIndexResourcePolicy defers to instead of its own static configured map. */
export interface LanguageCostEstimator {
	estimateBytes(languageId: string): number;
	/** The highest cost known across every language this estimator currently tracks -- for conservative capacity planning only (softActiveCeiling), never a specific per-admission estimate. Optional: an estimator with nothing to enumerate simply isn't consulted for this. */
	maxKnownCostBytes?(): number;
}

export interface AdaptiveWarmIndexResourcePolicyOptions {
	readonly resources: WarmIndexResourceSnapshotPort;
	readonly estimatedBytesByLanguage: Readonly<Record<string, number>>;
	readonly defaultEstimatedBytes: number;
	/** Takes over estimate() entirely when set -- a calibrator already falls back to estimatedBytesByLanguage/defaultEstimatedBytes itself once it has no real sample for a language yet, so this never needs to consult them directly. */
	readonly costEstimator?: LanguageCostEstimator;
}

const BUDGET_FACTOR: Readonly<Record<WarmIndexResourcePressure, number>> = Object.freeze({
	low: 1,
	moderate: 0.75,
	high: 0.5,
	critical: 0,
});

const IDLE_FACTOR: Readonly<Record<Exclude<WarmIndexResourcePressure, "low">, number>> = Object.freeze({
	moderate: 0.5,
	high: 0.25,
	critical: 0,
});

function assertPositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}

/** Converts a changing byte budget and pressure signal into deterministic admission and retention decisions. */
export class AdaptiveWarmIndexResourcePolicy implements WarmIndexResourcePolicy {
	constructor(private readonly options: AdaptiveWarmIndexResourcePolicyOptions) {
		assertPositiveSafeInteger(options.defaultEstimatedBytes, "defaultEstimatedBytes");
		for (const [languageId, estimate] of Object.entries(options.estimatedBytesByLanguage)) {
			if (!languageId) throw new TypeError("estimated language ids must not be empty");
			assertPositiveSafeInteger(estimate, `estimatedBytesByLanguage.${languageId}`);
		}
	}

	private snapshot(): WarmIndexResourceSnapshot {
		const snapshot = this.options.resources.current();
		if (!Number.isSafeInteger(snapshot.indexMemoryBudgetBytes) || snapshot.indexMemoryBudgetBytes < 0) {
			throw new TypeError("indexMemoryBudgetBytes must be a non-negative safe integer");
		}
		if (!(snapshot.pressure in BUDGET_FACTOR)) throw new TypeError(`unknown warm-index resource pressure: ${String(snapshot.pressure)}`);
		return snapshot;
	}

	private estimate(languageId: string): number {
		if (this.options.costEstimator) return this.options.costEstimator.estimateBytes(languageId);
		return this.options.estimatedBytesByLanguage[languageId] ?? this.options.defaultEstimatedBytes;
	}

	private estimatedBytes(languages: readonly string[]): number {
		return languages.reduce((total, languageId) => total + this.estimate(languageId), 0);
	}

	private effectiveBudget(snapshot: WarmIndexResourceSnapshot): number {
		return Math.floor(snapshot.indexMemoryBudgetBytes * BUDGET_FACTOR[snapshot.pressure]);
	}

	/** Worst-case per-index cost for capacity planning -- the calibrator's own tracked maximum when it can enumerate one, otherwise the highest static baseline across every configured language. Never optimistic: sizing capacity on an average would let a mix skewed toward the cheapest language overcommit against a later request for the most expensive one. */
	private conservativeCostPerIndex(): number {
		if (this.options.costEstimator?.maxKnownCostBytes) return this.options.costEstimator.maxKnownCostBytes();
		const staticCosts = Object.values(this.options.estimatedBytesByLanguage);
		return staticCosts.length > 0 ? Math.max(this.options.defaultEstimatedBytes, ...staticCosts) : this.options.defaultEstimatedBytes;
	}

	canAdmit(activeLanguages: readonly string[], requestedLanguage: string): boolean {
		const snapshot = this.snapshot();
		return this.estimatedBytes(activeLanguages) + this.estimate(requestedLanguage) <= this.effectiveBudget(snapshot);
	}

	isOverBudget(activeLanguages: readonly string[]): boolean {
		const snapshot = this.snapshot();
		return this.estimatedBytes(activeLanguages) > this.effectiveBudget(snapshot);
	}

	softActiveCeiling(activeLanguages: readonly string[]): number | undefined {
		let snapshot: WarmIndexResourceSnapshot;
		try {
			snapshot = this.snapshot();
		} catch {
			return undefined;
		}
		const cost = this.conservativeCostPerIndex();
		if (!Number.isFinite(cost) || cost <= 0) return undefined;
		const budget = this.effectiveBudget(snapshot);
		const committed = this.estimatedBytes(activeLanguages);
		const remaining = Math.max(0, budget - committed);
		return activeLanguages.length + Math.floor(remaining / cost);
	}

	maxIdleMs(configuredMaxIdleMs: number, activeLanguages: readonly string[]): number {
		if (!Number.isSafeInteger(configuredMaxIdleMs) || configuredMaxIdleMs < 0) {
			throw new TypeError("configuredMaxIdleMs must be a non-negative safe integer");
		}
		const snapshot = this.snapshot();
		if (snapshot.pressure !== "low") return Math.floor(configuredMaxIdleMs * IDLE_FACTOR[snapshot.pressure]);
		const budget = this.effectiveBudget(snapshot);
		const utilization = budget === 0 ? 1 : this.estimatedBytes(activeLanguages) / budget;
		if (utilization > 0.5) return configuredMaxIdleMs;
		return Math.min(Number.MAX_SAFE_INTEGER, configuredMaxIdleMs * 2);
	}

	status(activeLanguages: readonly string[]): WarmIndexResourceStatus {
		const snapshot = this.snapshot();
		return {
			pressure: snapshot.pressure,
			indexMemoryBudgetBytes: snapshot.indexMemoryBudgetBytes,
			effectiveIndexMemoryBudgetBytes: this.effectiveBudget(snapshot),
			estimatedActiveBytes: this.estimatedBytes(activeLanguages),
		};
	}
}
