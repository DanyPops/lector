import { describe, expect, it } from "bun:test";
import { LanguageServerCostCalibrator } from "../../src/code-intelligence/language-server-cost-calibrator.ts";
import type { LanguageServerProcessCostObserverPort } from "../../src/code-intelligence/lsp/language-server-process-cost-observer.ts";

class ScriptedObserver implements LanguageServerProcessCostObserverPort {
	private readonly scriptedByPid = new Map<number, number | undefined | Error>();

	script(pid: number, outcome: number | undefined | Error): void {
		this.scriptedByPid.set(pid, outcome);
	}

	sampleTreeBytes(rootPid: number): number | undefined {
		const outcome = this.scriptedByPid.get(rootPid);
		if (outcome instanceof Error) throw outcome;
		return outcome;
	}
}

describe("LanguageServerCostCalibrator", () => {
	it("returns the configured fallback before any valid sample exists", () => {
		const observer = new ScriptedObserver();
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: { typescript: 512 }, defaultEstimatedBytes: 256 });

		expect(calibrator.estimateBytes("typescript")).toBe(512);
		expect(calibrator.estimateBytes("go")).toBe(256); // no per-language fallback -- uses the default
	});

	it("adopts a valid sample as the new estimate once recorded", () => {
		const observer = new ScriptedObserver();
		observer.script(4242, 900_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: { typescript: 512 }, defaultEstimatedBytes: 256 });

		calibrator.recordSample("typescript", 4242);
		expect(calibrator.estimateBytes("typescript")).toBe(900_000);
	});

	it("never lowers the peak below a previously observed larger sample -- no admission underestimation", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 1_000_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: {}, defaultEstimatedBytes: 256 });

		calibrator.recordSample("typescript", 1);
		expect(calibrator.estimateBytes("typescript")).toBe(1_000_000);

		observer.script(1, 400_000); // the server settled to a smaller footprint after its own indexing burst
		calibrator.recordSample("typescript", 1);
		expect(calibrator.estimateBytes("typescript")).toBe(1_000_000); // still the peak, not the smaller settled value

		observer.script(1, 2_000_000); // a genuinely larger later sample does raise the peak
		calibrator.recordSample("typescript", 1);
		expect(calibrator.estimateBytes("typescript")).toBe(2_000_000);
	});

	it("tracks settled (most recent) separately from peak, for diagnostics only", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 1_000_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: {}, defaultEstimatedBytes: 256 });
		calibrator.recordSample("typescript", 1);
		observer.script(1, 400_000);
		calibrator.recordSample("typescript", 1);

		expect(calibrator.calibration("typescript")).toEqual({ peakBytes: 1_000_000, settledBytes: 400_000 });
	});

	it("ignores an undefined sample (observer could not measure), keeping the existing estimate", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 1_000_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: {}, defaultEstimatedBytes: 256 });
		calibrator.recordSample("typescript", 1);

		observer.script(1, undefined); // process gone, or the observer hit one of its own bounds
		calibrator.recordSample("typescript", 1);
		expect(calibrator.estimateBytes("typescript")).toBe(1_000_000);
	});

	it("ignores a zero or negative sample as invalid, keeping the existing estimate", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 1_000_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: {}, defaultEstimatedBytes: 256 });
		calibrator.recordSample("typescript", 1);

		observer.script(1, 0);
		calibrator.recordSample("typescript", 1);
		observer.script(1, -50);
		calibrator.recordSample("typescript", 1);
		expect(calibrator.estimateBytes("typescript")).toBe(1_000_000);
	});

	it("never throws even when the observer itself throws", () => {
		const observer = new ScriptedObserver();
		observer.script(1, new Error("boom"));
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: { typescript: 512 }, defaultEstimatedBytes: 256 });

		expect(() => calibrator.recordSample("typescript", 1)).not.toThrow();
		expect(calibrator.estimateBytes("typescript")).toBe(512);
	});

	it("maxKnownCostBytes returns the highest static fallback when nothing has been sampled yet", () => {
		const observer = new ScriptedObserver();
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: { typescript: 512, rust: 900 }, defaultEstimatedBytes: 256 });

		expect(calibrator.maxKnownCostBytes()).toBe(900);
	});

	it("maxKnownCostBytes rises once a real sample exceeds every static fallback", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 5_000_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: { typescript: 512, rust: 900 }, defaultEstimatedBytes: 256 });
		calibrator.recordSample("typescript", 1);

		expect(calibrator.maxKnownCostBytes()).toBe(5_000_000);
	});

	it("maxKnownCostBytes never drops once a real sample raised it, mirroring estimateBytes' own peak-tracking", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 5_000_000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: { typescript: 512 }, defaultEstimatedBytes: 256 });
		calibrator.recordSample("typescript", 1);
		observer.script(1, 100);
		calibrator.recordSample("typescript", 1);

		expect(calibrator.maxKnownCostBytes()).toBe(5_000_000);
	});

	it("retains bounded state -- one entry per distinct language actually sampled, never growing with repeated samples of the same language", () => {
		const observer = new ScriptedObserver();
		observer.script(1, 1000);
		const calibrator = new LanguageServerCostCalibrator({ observer, fallbackBytesByLanguage: {}, defaultEstimatedBytes: 256 });

		for (let i = 0; i < 1000; i++) calibrator.recordSample("typescript", 1);
		calibrator.recordSample("go", 1);

		expect(calibrator.calibration("typescript")).toBeDefined();
		expect(calibrator.calibration("go")).toBeDefined();
		expect(calibrator.calibration("rust")).toBeUndefined();
	});
});
