/**
 * FallbackCodeIntelligenceIndex delegates every identity-aware operation
 * straight to its primary (never a fallback -- those only ever serve name
 * discovery). This file specifically covers releaseFile, an optional
 * capability the primary may or may not implement.
 */
import { describe, expect, it } from "bun:test";
import { type ClosableIntelligenceIndex, FallbackCodeIntelligenceIndex } from "../../src/adapters/fallback-code-intelligence-index.ts";
import type { IntelligenceProvenance } from "../../src/domain/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../../src/ports/code-intelligence-port.ts";

const PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "stub-server",
	languageId: "test",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

function stubPrimary(releaseFile?: (path: string) => Promise<void>): ClosableIntelligenceIndex & CodeIntelligencePort {
	return {
		provenance: PROVENANCE,
		findSymbols: async () => ({ symbols: [], truncated: false, provenance: PROVENANCE }),
		goToDefinition: async () => [],
		goToImplementation: async () => [],
		findReferences: async () => [],
		hover: async () => undefined,
		documentSymbols: async () => [],
		diagnostics: async () => [],
		prepareCallHierarchy: async () => [],
		incomingCalls: async () => [],
		outgoingCalls: async () => [],
		releaseFile,
		close: async () => {},
	};
}

describe("FallbackCodeIntelligenceIndex releaseFile delegation", () => {
	it("delegates to the primary when it implements releaseFile", async () => {
		const released: string[] = [];
		const primary = stubPrimary(async (path) => {
			released.push(path);
		});
		const index = new FallbackCodeIntelligenceIndex(primary, []);

		await index.releaseFile("/repo/a.ts");

		expect(released).toEqual(["/repo/a.ts"]);
	});

	it("resolves harmlessly when the primary does not implement releaseFile", async () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(undefined), []);

		await expect(index.releaseFile("/repo/a.ts")).resolves.toBeUndefined();
	});
});
