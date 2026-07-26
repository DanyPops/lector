import { describe, expect, it } from "bun:test";
import { PolyglotCodeIntelligenceIndex, type PolyglotIndexEntry } from "../../src/adapters/polyglot-code-intelligence-index.ts";
import type { IntelligenceProvenance } from "../../src/domain/intelligence-provenance.ts";
import { GO_DESCRIPTOR, PYTHON_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import type { SymbolSearchResult, WorkspaceLocation } from "../../src/domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "../../src/ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "../../src/ports/symbol-index-port.ts";

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
});
