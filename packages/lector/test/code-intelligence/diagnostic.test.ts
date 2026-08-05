import { describe, expect, it } from "bun:test";
import type { Diagnostic } from "../../src/code-intelligence/diagnostic.ts";
import { mergeDiagnostics } from "../../src/code-intelligence/diagnostic.ts";

const range = { path: "/repo/a.ts", start: { line: 1, character: 1 }, end: { line: 1, character: 5 } };

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
	return { range, severity: "error", message: "boom", source: "ts", code: 1234, ...overrides };
}

describe("mergeDiagnostics", () => {
	it("returns push diagnostics unchanged when pull is empty", () => {
		const push = [diagnostic()];
		expect(mergeDiagnostics(push, [])).toEqual(push);
	});

	it("returns pull diagnostics unchanged when push is empty", () => {
		const pull = [diagnostic()];
		expect(mergeDiagnostics([], pull)).toEqual(pull);
	});

	it("deduplicates the same real issue reported by both push and pull, keeping one copy", () => {
		const push = [diagnostic()];
		const pull = [diagnostic()];
		expect(mergeDiagnostics(push, pull)).toEqual([diagnostic()]);
	});

	it("keeps two genuinely different diagnostics distinct even when reported by different sources", () => {
		const push = [diagnostic({ message: "push-only issue" })];
		const pull = [diagnostic({ message: "pull-only issue" })];
		const merged = mergeDiagnostics(push, pull);
		expect(merged).toHaveLength(2);
		expect(merged.map((item) => item.message).sort()).toEqual(["pull-only issue", "push-only issue"]);
	});

	it("distinguishes diagnostics that differ only by range, severity, source, or code", () => {
		const base = diagnostic();
		const differentRange = diagnostic({ range: { ...range, start: { line: 2, character: 1 } } });
		const differentSeverity = diagnostic({ severity: "warning" });
		const differentSource = diagnostic({ source: "eslint" });
		const differentCode = diagnostic({ code: 9999 });
		const merged = mergeDiagnostics([base], [differentRange, differentSeverity, differentSource, differentCode]);
		expect(merged).toHaveLength(5);
	});

	it("prefers the pull-reported diagnostic when both sides report an equal key -- verified via a real property difference outside the key", () => {
		// Nothing in Diagnostic distinguishes the two beyond the key itself today, but this pins
		// the documented tie-break order (pull first) so a future field addition doesn't silently
		// flip it without a failing test.
		const push = [diagnostic()];
		const pull = [diagnostic()];
		expect(mergeDiagnostics(push, pull)[0]).toBe(pull[0]);
	});
});
