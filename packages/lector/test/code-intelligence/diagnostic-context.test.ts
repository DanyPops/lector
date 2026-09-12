import { describe, expect, it } from "bun:test";
import { DiagnosticContextTracker } from "../../src/code-intelligence/diagnostic-context.ts";

describe("diagnostic project context", () => {
	it("keeps missing server evidence unknown", () => {
		const context = new DiagnosticContextTracker().snapshot({});
		expect(context.confidence).toBe("unknown");
		expect(context.setupFindings).toEqual([]);
	});

	it("accepts a quiescent healthy server report", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "ok", quiescent: true });
		expect(tracker.snapshot({}).confidence).toBe("reported-ready");
	});

	it("separates Rust setup failures from source errors", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "warning", quiescent: true, message: "Failed to find sysroot; build script failed; proc-macro expansion failed" });
		const context = tracker.snapshot({});
		expect(context.confidence).toBe("degraded");
		expect(context.setupFindings.map((finding) => finding.kind)).toEqual(["standard-library", "build-script", "proc-macro"]);
		expect(context.setupFindings.every((finding) => finding.evidence === "server-status")).toBe(true);
	});

	it("separates Python interpreter setup failures", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordMessage({ type: 1, message: "Python interpreter could not be found" });
		expect(tracker.snapshot({}).setupFindings).toEqual([
			{ kind: "interpreter", evidence: "server-message", action: "Verify the configured Python interpreter and environment, then reload the project." },
		]);
	});

	it("keeps ordinary type errors out of setup findings", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordMessage({ type: 1, message: "expected &[Transfer], found &[Transfer; 2]" });
		expect(tracker.snapshot({}).setupFindings).toEqual([]);
		expect(tracker.snapshot({}).confidence).toBe("unknown");
	});

	it("reports stale published versions independently", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "ok", quiescent: true });
		const context = tracker.snapshot({ synchronizedVersion: 2, publishedVersion: 1 });
		expect(context.confidence).toBe("degraded");
		expect(context.setupFindings.map((finding) => finding.kind)).toEqual(["stale-diagnostics"]);
		expect(context.document).toEqual({ synchronizedVersion: 2, publishedVersion: 1 });
	});

	it("clears status findings after recovery", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "error", quiescent: true, message: "Failed to load workspace" });
		expect(tracker.snapshot({}).confidence).toBe("degraded");
		tracker.recordStatus({ health: "ok", quiescent: true });
		expect(tracker.snapshot({}).confidence).toBe("reported-ready");
		expect(tracker.snapshot({}).setupFindings).toEqual([]);
	});

	it("subscribes to quiescence with a deadline", async () => {
		const tracker = new DiagnosticContextTracker();
		expect(await tracker.waitForQuiescence(10)).toBe(false);
		tracker.recordStatus({ health: "ok", quiescent: false });
		const ready = tracker.waitForQuiescence(1000);
		tracker.recordStatus({ health: "ok", quiescent: true });
		expect(await ready).toBe(true);
		tracker.recordStatus({ health: "ok", quiescent: false });
		expect(await tracker.waitForQuiescence(1)).toBe(false);
	});

	it("bounds readiness subscribers and deadlines", async () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "ok", quiescent: false });
		const pending = Array.from({ length: 32 }, () => tracker.waitForQuiescence(1000));
		expect(await tracker.waitForQuiescence(1000)).toBe(false);
		tracker.recordStatus({ health: "ok", quiescent: true });
		expect((await Promise.all(pending)).every(Boolean)).toBe(true);
		await expect(tracker.waitForQuiescence(300001)).rejects.toThrow("timeoutMs");
	});

	it("bounds reported server versions", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordServerInfo({ version: "1.96.0 (ac68faa 2026-05-25)" });
		expect(tracker.snapshot({}).server.version).toBe("1.96.0 (ac68faa 2026-05-25)");
		tracker.recordServerInfo({ version: `1.2.3-${"x".repeat(100_000)}` });
		expect(tracker.snapshot({}).server.version).toBe("1.96.0 (ac68faa 2026-05-25)");
	});

	it("keeps background loading incomplete", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "ok", quiescent: false });
		expect(tracker.snapshot({}).confidence).toBe("unknown");
	});

	it("bounds messages and ignores malformed status", () => {
		const tracker = new DiagnosticContextTracker();
		tracker.recordStatus({ health: "invented", quiescent: true });
		expect(tracker.snapshot({}).confidence).toBe("unknown");
		for (let index = 0; index < 100; index++) tracker.recordMessage({ type: 1, message: `Python interpreter could not be found ${"x".repeat(100_000)}` });
		const context = tracker.snapshot({});
		expect(context.truncated).toBe(true);
		expect(context.setupFindings).toHaveLength(1);
		expect(JSON.stringify(context).length).toBeLessThan(4096);
		expect(JSON.stringify(context)).not.toContain("xxxx");
	});
});
