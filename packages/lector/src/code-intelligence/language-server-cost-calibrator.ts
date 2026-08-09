import type { LanguageServerProcessCostObserverPort } from "./lsp/language-server-process-cost-observer.ts";
import type { LanguageCostEstimator } from "./warm-index-resource-policy.ts";

export interface LanguageServerCostCalibratorOptions {
	readonly observer: LanguageServerProcessCostObserverPort;
	/** The same configured defaults AdaptiveWarmIndexResourcePolicy would otherwise use directly -- consulted only for a language with no valid sample yet. */
	readonly fallbackBytesByLanguage: Readonly<Record<string, number>>;
	readonly defaultEstimatedBytes: number;
}

export interface LanguageCostCalibration {
	/** Highest valid sample ever observed for this language -- what estimateBytes() returns, since admission must never underestimate a real footprint already seen. */
	readonly peakBytes: number;
	/** Most recent valid sample -- informational only; nothing safety-critical reads this. */
	readonly settledBytes: number;
}

/**
 * Replaces AdaptiveWarmIndexResourcePolicy's static per-language byte guesses with real,
 * continuously-updated observations, while keeping its own bounded state: one {peak, settled}
 * pair per language ever sampled, never a growing history. peakBytes is monotonic non-decreasing
 * per language -- once a real process tree is observed using N bytes, no later, smaller sample
 * (a language server settling after its own initial indexing burst, for instance) is ever allowed
 * to lower the estimate admission relies on below that.
 */
export class LanguageServerCostCalibrator implements LanguageCostEstimator {
	private readonly byLanguage = new Map<string, LanguageCostCalibration>();

	constructor(private readonly options: LanguageServerCostCalibratorOptions) {}

	private fallback(languageId: string): number {
		return this.options.fallbackBytesByLanguage[languageId] ?? this.options.defaultEstimatedBytes;
	}

	estimateBytes(languageId: string): number {
		return this.byLanguage.get(languageId)?.peakBytes ?? this.fallback(languageId);
	}

	/** Path-free, per-language calibration snapshot -- for status/diagnostics only. */
	calibration(languageId: string): LanguageCostCalibration | undefined {
		return this.byLanguage.get(languageId);
	}

	/**
	 * Samples one live process tree and folds it into this language's calibration, if the sample
	 * is a valid positive byte count. Never throws: an observer that fails, or a process that has
	 * already exited, simply leaves the existing calibration (or the configured fallback) in
	 * place -- calibration only ever adds confidence, it never removes the conservative default a
	 * caller can already fall back on.
	 */
	recordSample(languageId: string, pid: number): void {
		let sampleBytes: number | undefined;
		try {
			sampleBytes = this.options.observer.sampleTreeBytes(pid);
		} catch {
			sampleBytes = undefined;
		}
		if (sampleBytes === undefined || !Number.isFinite(sampleBytes) || sampleBytes <= 0) return;
		const existing = this.byLanguage.get(languageId);
		this.byLanguage.set(languageId, { peakBytes: Math.max(existing?.peakBytes ?? 0, sampleBytes), settledBytes: sampleBytes });
	}
}
