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
}

export interface WarmIndexRetentionPolicy {
	maxIdleMs(configuredMaxIdleMs: number, activeLanguages: readonly string[]): number;
}

export interface WarmIndexResourcePolicy extends WarmIndexAdmissionPolicy, WarmIndexRetentionPolicy {}

export interface AdaptiveWarmIndexResourcePolicyOptions {
	readonly resources: WarmIndexResourceSnapshotPort;
	readonly estimatedBytesByLanguage: Readonly<Record<string, number>>;
	readonly defaultEstimatedBytes: number;
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
		return this.options.estimatedBytesByLanguage[languageId] ?? this.options.defaultEstimatedBytes;
	}

	private estimatedBytes(languages: readonly string[]): number {
		return languages.reduce((total, languageId) => total + this.estimate(languageId), 0);
	}

	private effectiveBudget(snapshot: WarmIndexResourceSnapshot): number {
		return Math.floor(snapshot.indexMemoryBudgetBytes * BUDGET_FACTOR[snapshot.pressure]);
	}

	canAdmit(activeLanguages: readonly string[], requestedLanguage: string): boolean {
		const snapshot = this.snapshot();
		return this.estimatedBytes(activeLanguages) + this.estimate(requestedLanguage) <= this.effectiveBudget(snapshot);
	}

	isOverBudget(activeLanguages: readonly string[]): boolean {
		const snapshot = this.snapshot();
		return this.estimatedBytes(activeLanguages) > this.effectiveBudget(snapshot);
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
}
