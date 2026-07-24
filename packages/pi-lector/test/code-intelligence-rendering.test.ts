/**
 * go_to_definition, find_references, hover, document_symbols, and
 * diagnostics have no built-in pi-coding-agent equivalent to inherit
 * rendering from, exactly like find_symbols. Same plain pass-through fake
 * theme approach: asserts on the actual rendered text, no ANSI noise.
 */
import { describe, expect, it } from "bun:test";
import type { CallHierarchyEntry, Diagnostic, DocumentSymbolEntry, WorkspaceLocation } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	formatDiagnosticsCall,
	formatDiagnosticsResult,
	formatDocumentSymbolsCall,
	formatDocumentSymbolsResult,
	formatFindReferencesCall,
	formatFindReferencesResult,
	formatGoToDefinitionCall,
	formatGoToDefinitionResult,
	formatHoverCall,
	formatHoverResult,
	formatIncomingCallsCall,
	formatIncomingCallsResult,
	formatOutgoingCallsCall,
	formatOutgoingCallsResult,
	formatPrepareCallHierarchyCall,
	formatPrepareCallHierarchyResult,
} from "../extension/src/code-intelligence-rendering.ts";
import type { LectorTheme } from "../extension/src/lector-tui-theme.ts";

// keyHint() reads pi's global theme singleton independent of the LectorTheme fake below.
initTheme();

const plainTheme: LectorTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function location(overrides: Partial<WorkspaceLocation> = {}): WorkspaceLocation {
	return { path: "src/domain/exact-edit.ts", line: 12, character: 1, ...overrides };
}

describe("formatGoToDefinitionCall/Result", () => {
	it("shows the tool name and position", () => {
		const text = formatGoToDefinitionCall({ path: "src/index.ts", line: 3, character: 5 }, plainTheme);
		expect(text).toContain("go_to_definition");
		expect(text).toContain("src/index.ts:3:5");
	});

	it("shows a clear message when no definition is found", () => {
		expect(formatGoToDefinitionResult([], false, plainTheme)).toContain("No definition found");
	});

	it("lists every returned location", () => {
		const text = formatGoToDefinitionResult([location(), location({ path: "src/index.ts", line: 4 })], false, plainTheme);
		expect(text).toContain("src/domain/exact-edit.ts:12:1");
		expect(text).toContain("src/index.ts:4:1");
	});
});

describe("formatFindReferencesCall/Result", () => {
	it("shows the tool name and position", () => {
		const text = formatFindReferencesCall({ path: "src/index.ts", line: 3, character: 5 }, plainTheme);
		expect(text).toContain("find_references");
		expect(text).toContain("src/index.ts:3:5");
	});

	it("shows a clear message when nothing matched", () => {
		expect(formatFindReferencesResult([], false, plainTheme)).toContain("No references found");
	});

	it("truncates past the default visible count and says how many more remain", () => {
		const locations = Array.from({ length: 12 }, (_, i) => location({ line: i + 1 }));
		const text = formatFindReferencesResult(locations, false, plainTheme);
		expect(text).toContain("4 more");
	});

	it("shows every result when expanded", () => {
		const locations = Array.from({ length: 12 }, (_, i) => location({ line: i + 1 }));
		const text = formatFindReferencesResult(locations, true, plainTheme);
		expect(text).not.toContain("more");
		expect(text).toContain("src/domain/exact-edit.ts:12:1");
	});
});

describe("formatHoverCall/Result", () => {
	it("shows the tool name and position", () => {
		const text = formatHoverCall({ path: "src/index.ts", line: 3, character: 5 }, plainTheme);
		expect(text).toContain("hover");
		expect(text).toContain("src/index.ts:3:5");
	});

	it("shows a clear message when no hover information is available", () => {
		expect(formatHoverResult(undefined, false, plainTheme)).toContain("No hover information available");
	});

	it("shows short hover contents in full", () => {
		const text = formatHoverResult({ contents: "```ts\nfunction exactEdit(): void\n```" }, false, plainTheme);
		expect(text).toContain("exactEdit");
	});

	it("truncates long hover contents when not expanded, and shows all of it when expanded", () => {
		const contents = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const collapsed = formatHoverResult({ contents }, false, plainTheme);
		const expanded = formatHoverResult({ contents }, true, plainTheme);
		expect(collapsed).not.toContain("line 9");
		expect(collapsed).toContain("more line");
		expect(expanded).toContain("line 9");
	});
});

describe("formatDocumentSymbolsCall/Result", () => {
	function entry(overrides: Partial<DocumentSymbolEntry> = {}): DocumentSymbolEntry {
		return {
			name: "exactEdit",
			kind: "function",
			range: { path: "src/domain/exact-edit.ts", start: { line: 12, character: 1 }, end: { line: 14, character: 1 } },
			selectionRange: { path: "src/domain/exact-edit.ts", start: { line: 12, character: 1 }, end: { line: 12, character: 10 } },
			...overrides,
		};
	}

	it("shows the tool name and path", () => {
		const text = formatDocumentSymbolsCall({ path: "src/index.ts" }, plainTheme);
		expect(text).toContain("document_symbols");
		expect(text).toContain("src/index.ts");
	});

	it("shows a clear message when the file has no symbols", () => {
		expect(formatDocumentSymbolsResult([], false, plainTheme)).toContain("No symbols found");
	});

	it("flattens hierarchical children with indentation", () => {
		const symbols = [entry({ name: "Outer", kind: "class", children: [entry({ name: "inner", kind: "method" })] })];
		const text = formatDocumentSymbolsResult(symbols, false, plainTheme);
		expect(text).toContain("Outer");
		expect(text).toContain("inner");
	});
});

describe("formatDiagnosticsCall/Result", () => {
	function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
		return {
			range: { path: "src/domain/exact-edit.ts", start: { line: 12, character: 1 }, end: { line: 12, character: 10 } },
			severity: "error",
			message: "Type 'string' is not assignable to type 'number'.",
			source: "typescript",
			code: 2322,
			...overrides,
		};
	}

	it("shows the tool name and path", () => {
		const text = formatDiagnosticsCall({ path: "src/index.ts" }, plainTheme);
		expect(text).toContain("diagnostics");
		expect(text).toContain("src/index.ts");
	});

	it("shows a clear, positive message when there are no diagnostics", () => {
		expect(formatDiagnosticsResult([], false, plainTheme)).toContain("No diagnostics");
	});

	it("shows severity, location, message, and source/code for each diagnostic", () => {
		const text = formatDiagnosticsResult([diagnostic()], false, plainTheme);
		expect(text).toContain("error");
		expect(text).toContain("src/domain/exact-edit.ts:12:1");
		expect(text).toContain("not assignable");
		expect(text).toContain("typescript");
		expect(text).toContain("2322");
	});

	it("truncates past the default visible count and says how many more remain", () => {
		const diagnostics = Array.from({ length: 14 }, (_, i) => diagnostic({ message: `error ${i}` }));
		const text = formatDiagnosticsResult(diagnostics, false, plainTheme);
		expect(text).toContain("2 more");
	});
});

function callHierarchyEntry(overrides: Partial<CallHierarchyEntry> = {}): CallHierarchyEntry {
	return {
		name: "add",
		kind: "function",
		location: { path: "src/math.ts", line: 1, character: 17 },
		range: { path: "src/math.ts", start: { line: 1, character: 1 }, end: { line: 3, character: 2 } },
		...overrides,
	};
}

describe("formatPrepareCallHierarchyCall/Result", () => {
	it("shows the tool name and position", () => {
		const text = formatPrepareCallHierarchyCall({ path: "src/math.ts", line: 1, character: 17 }, plainTheme);
		expect(text).toContain("prepare_call_hierarchy");
		expect(text).toContain("src/math.ts:1:17");
	});

	it("shows a clear message when nothing resolves at that position", () => {
		expect(formatPrepareCallHierarchyResult([], plainTheme)).toContain("No call-hierarchy root");
	});

	it("shows every resolved item's kind, name, and location", () => {
		const text = formatPrepareCallHierarchyResult([callHierarchyEntry()], plainTheme);
		expect(text).toContain("function");
		expect(text).toContain("add");
		expect(text).toContain("src/math.ts:1:17");
	});
});

describe("formatIncomingCallsCall/Result", () => {
	it("shows the tool name and position", () => {
		const text = formatIncomingCallsCall({ path: "src/math.ts", line: 1, character: 17 }, plainTheme);
		expect(text).toContain("incoming_calls");
	});

	it("shows a clear message when there are no callers", () => {
		expect(formatIncomingCallsResult([], false, plainTheme)).toContain("No incoming calls found");
	});

	it("lists each caller", () => {
		const text = formatIncomingCallsResult([{ from: callHierarchyEntry({ name: "addTwice" }), fromRanges: [] }], false, plainTheme);
		expect(text).toContain("addTwice");
	});

	it("truncates past the default visible count", () => {
		const calls = Array.from({ length: 14 }, (_, i) => ({ from: callHierarchyEntry({ name: `caller${i}` }), fromRanges: [] }));
		const text = formatIncomingCallsResult(calls, false, plainTheme);
		expect(text).toContain("2 more");
	});
});

describe("formatOutgoingCallsCall/Result", () => {
	it("shows the tool name and position", () => {
		const text = formatOutgoingCallsCall({ path: "src/math.ts", line: 4, character: 17 }, plainTheme);
		expect(text).toContain("outgoing_calls");
	});

	it("shows a clear message when there are no callees", () => {
		expect(formatOutgoingCallsResult([], false, plainTheme)).toContain("No outgoing calls found");
	});

	it("lists each callee", () => {
		const text = formatOutgoingCallsResult([{ to: callHierarchyEntry({ name: "add" }), fromRanges: [] }], false, plainTheme);
		expect(text).toContain("add");
	});
});
