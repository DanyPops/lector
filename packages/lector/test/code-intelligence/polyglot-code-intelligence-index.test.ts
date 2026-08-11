import { describe, expect, it } from "bun:test";
import type { IntelligenceProvenance } from "../../src/code-intelligence/intelligence-provenance.ts";
import { GO_DESCRIPTOR, PYTHON_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { PolyglotCodeIntelligenceIndex, type PolyglotIndexEntry } from "../../src/code-intelligence/polyglot-code-intelligence-index.ts";
import type { CodeIntelligencePort } from "../../src/code-intelligence/port.ts";
import type { SymbolIndexPort } from "../../src/code-intelligence/symbol-index-port.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "../../src/workspace/workspace-symbol.ts";

function provenance(languageId: string, backend: string): IntelligenceProvenance {
	return { fidelity: "semantic", backend, languageId, authority: "language-server", freshness: "live-process", limitations: [] };
}

function stubEntry(descriptor: typeof GO_DESCRIPTOR | typeof PYTHON_DESCRIPTOR, findSymbols: () => Promise<SymbolSearchResult>): PolyglotIndexEntry {
	const location: WorkspaceLocation = { path: `/repo/main${descriptor.extensions[0]}`, line: 1, character: 1 };
	const index: SymbolIndexPort & CodeIntelligencePort = {
		provenance: provenance(descriptor.languageId, descriptor.backendId),
		findSymbols,
		goToDefinition: async () => [location],
		goToImplementation: async () => [location],
		findReferences: async () => [location],
		hover: async () => undefined,
		documentSymbols: async () => [],
		diagnostics: async () => [],
		prepareCallHierarchy: async () => [],
		incomingCalls: async () => [],
		outgoingCalls: async () => [],
	};
	return { descriptor, index };
}

describe("PolyglotCodeIntelligenceIndex", () => {
	it("keeps a failed backend machine-distinct while returning another backend's bounded results", async () => {
		const goProvenance = provenance("go", "gopls");
		const index = new PolyglotCodeIntelligenceIndex([
			stubEntry(GO_DESCRIPTOR, async () => ({
				symbols: [{ name: "Ready", kind: "function", location: { path: "/repo/main.go", line: 1, character: 1 } }],
				truncated: false,
				provenance: goProvenance,
			})),
			stubEntry(PYTHON_DESCRIPTOR, async () => {
				throw new Error("backend unavailable");
			}),
		]);

		const result = await index.findSymbols("ready", { maxResults: 1 });

		expect(result.completeness).toBe("partial");
		expect(result.symbols).toEqual([{ name: "Ready", kind: "function", location: { path: "/repo/main.go", line: 1, character: 1 }, provenance: goProvenance }]);
		expect(result.sources).toEqual([
			{ provenance: goProvenance, status: "ready", symbolCount: 1, truncated: false },
			{
				provenance: provenance("python", "pyright"),
				status: "failed",
				symbolCount: 0,
				error: { code: "Error", message: "backend unavailable" },
			},
		]);
	});

	it("dispatches file-specific operations by extension", async () => {
		const go = stubEntry(GO_DESCRIPTOR, async () => ({ symbols: [], truncated: false, provenance: provenance("go", "gopls") }));
		const python = stubEntry(PYTHON_DESCRIPTOR, async () => ({ symbols: [], truncated: false, provenance: provenance("python", "pyright") }));
		const index = new PolyglotCodeIntelligenceIndex([go, python]);

		expect(await index.goToDefinition({ path: "/repo/main.go", line: 1, character: 1 })).toEqual([{ path: "/repo/main.go", line: 1, character: 1 }]);
		expect(await index.goToDefinition({ path: "/repo/main.py", line: 1, character: 1 })).toEqual([{ path: "/repo/main.py", line: 1, character: 1 }]);
	});

	it("dispatches releaseFile to the extension-matched backend, and tolerates a backend that doesn't implement it", async () => {
		const released: string[] = [];
		const goIndex: SymbolIndexPort & CodeIntelligencePort = {
			provenance: provenance("go", "gopls"),
			findSymbols: async () => ({ symbols: [], truncated: false, provenance: provenance("go", "gopls") }),
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async () => [],
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			releaseFile: async (path) => {
				released.push(path);
			},
		};
		const go: PolyglotIndexEntry = { descriptor: GO_DESCRIPTOR, index: goIndex };
		// python's stub deliberately has no releaseFile at all -- a backend without the capability.
		const python = stubEntry(PYTHON_DESCRIPTOR, async () => ({ symbols: [], truncated: false, provenance: provenance("python", "pyright") }));
		const index = new PolyglotCodeIntelligenceIndex([go, python]);

		await index.releaseFile("/repo/main.go");
		expect(released).toEqual(["/repo/main.go"]);

		await expect(index.releaseFile("/repo/main.py")).resolves.toBeUndefined();
	});

	it("dispatches documentHighlights to the extension-matched backend, and degrades to an empty array for a backend that doesn't implement it -- the same live gap found and fixed in FallbackCodeIntelligenceIndex, checked here too since this is a second, separate CodeIntelligencePort wrapper predating the port method", async () => {
		const highlight = { range: { path: "/repo/main.go", start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, kind: "read" as const };
		const goIndex: SymbolIndexPort & CodeIntelligencePort = {
			provenance: provenance("go", "gopls"),
			findSymbols: async () => ({ symbols: [], truncated: false, provenance: provenance("go", "gopls") }),
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async () => [],
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			documentHighlights: async () => [highlight],
		};
		const go: PolyglotIndexEntry = { descriptor: GO_DESCRIPTOR, index: goIndex };
		// python's stub deliberately has no documentHighlights at all -- a backend without the capability.
		const python = stubEntry(PYTHON_DESCRIPTOR, async () => ({ symbols: [], truncated: false, provenance: provenance("python", "pyright") }));
		const index = new PolyglotCodeIntelligenceIndex([go, python]);

		await expect(index.documentHighlights?.({ path: "/repo/main.go", line: 1, character: 1 })).resolves.toEqual([highlight]);
		await expect(index.documentHighlights?.({ path: "/repo/main.py", line: 1, character: 1 })).resolves.toEqual([]);
	});
});
