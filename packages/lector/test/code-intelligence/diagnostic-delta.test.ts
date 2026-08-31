import { describe, expect, it } from "bun:test";
import type { Diagnostic } from "../../src/code-intelligence/diagnostic.ts";
import { diagnosticDelta } from "../../src/code-intelligence/diagnostic-delta.ts";

const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
	range: { path: "/repo/src/file.ts", start: { line: 2, character: 3 }, end: { line: 2, character: 8 } },
	severity: "error",
	message: "Type mismatch",
	source: "typescript",
	code: 2322,
	...overrides,
});

describe("diagnosticDelta", () => {
	it("returns only introduced, resolved, and changed diagnostics", () => {
		const unchanged = diagnostic();
		const resolved = diagnostic({ code: 1001, message: "Resolved issue" });
		const beforeChanged = diagnostic({ code: 2002, severity: "warning", message: "Old message" });
		const introduced = diagnostic({ code: 3003, message: "Introduced issue" });
		const afterChanged = diagnostic({ code: 2002, severity: "error", message: "New message" });

		expect(diagnosticDelta([unchanged, resolved, beforeChanged], [unchanged, introduced, afterChanged])).toEqual({
			introduced: [introduced],
			resolved: [resolved],
			changed: [{ before: beforeChanged, after: afterChanged }],
		});
	});

	it("normalizes message whitespace and source casing before comparison", () => {
		const before = diagnostic({ message: "Type   mismatch\n in assignment", source: "TypeScript" });
		const after = diagnostic({ message: " Type mismatch in assignment ", source: "typescript" });
		expect(diagnosticDelta([before], [after])).toEqual({ introduced: [], resolved: [], changed: [] });
	});

	it("orders output deterministically by path and range", () => {
		const later = diagnostic({ range: { path: "/repo/z.ts", start: { line: 9, character: 1 }, end: { line: 9, character: 2 } }, code: 9 });
		const earlier = diagnostic({ range: { path: "/repo/a.ts", start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, code: 1 });
		expect(diagnosticDelta([], [later, earlier]).introduced).toEqual([earlier, later]);
	});
});
