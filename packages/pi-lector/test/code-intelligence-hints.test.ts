import { describe, expect, it } from "bun:test";
import type { Diagnostic, DocumentSymbolEntry } from "@danypops/lector";
import { buildPostEditDiagnosticsHint, buildPostReadStructureHint } from "../extension/src/code-intelligence-hints.ts";

const RANGE = { path: "/x.ts", start: { line: 1, character: 1 }, end: { line: 1, character: 2 } };

function diagnostic(severity: Diagnostic["severity"]): Diagnostic {
	return { range: RANGE, severity, message: "test" };
}

function symbol(name: string): DocumentSymbolEntry {
	return { name, kind: "function", range: RANGE, selectionRange: RANGE };
}

describe("buildPostEditDiagnosticsHint", () => {
	it("returns undefined for no diagnostics", () => {
		expect(buildPostEditDiagnosticsHint([])).toBeUndefined();
	});

	it("returns undefined when only info/hint severities are present -- not noteworthy enough to surface", () => {
		expect(buildPostEditDiagnosticsHint([diagnostic("information"), diagnostic("hint")])).toBeUndefined();
	});

	it("counts errors and warnings separately, singular vs. plural", () => {
		expect(buildPostEditDiagnosticsHint([diagnostic("error")])).toBe("Lector: 1 error on this file (see the diagnostics tool for detail).");
		expect(buildPostEditDiagnosticsHint([diagnostic("error"), diagnostic("error")])).toBe(
			"Lector: 2 errors on this file (see the diagnostics tool for detail).",
		);
		expect(buildPostEditDiagnosticsHint([diagnostic("warning")])).toBe("Lector: 1 warning on this file (see the diagnostics tool for detail).");
	});

	it("reports both counts together when both are present", () => {
		expect(buildPostEditDiagnosticsHint([diagnostic("error"), diagnostic("warning"), diagnostic("warning")])).toBe(
			"Lector: 1 error, 2 warnings on this file (see the diagnostics tool for detail).",
		);
	});

	it("ignores info/hint severities even alongside a real error", () => {
		expect(buildPostEditDiagnosticsHint([diagnostic("error"), diagnostic("information")])).toBe(
			"Lector: 1 error on this file (see the diagnostics tool for detail).",
		);
	});
});

describe("buildPostReadStructureHint", () => {
	it("returns undefined below the threshold -- a small file's structure is already visible in a plain read", () => {
		expect(buildPostReadStructureHint([symbol("a"), symbol("b")])).toBeUndefined();
	});

	it("returns a hint at and above the threshold", () => {
		const symbols = Array.from({ length: 8 }, (_, i) => symbol(`s${i}`));
		expect(buildPostReadStructureHint(symbols)).toBe(
			"Lector: this file has 8 top-level symbols -- document_symbols/find_references/go_to_definition can target one directly instead of rereading the whole file.",
		);
	});
});
