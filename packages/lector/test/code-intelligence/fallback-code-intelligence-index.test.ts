/**
 * FallbackCodeIntelligenceIndex delegates every identity-aware operation
 * straight to its primary (never a fallback -- those only ever serve name
 * discovery). This file specifically covers releaseFile, an optional
 * capability the primary may or may not implement.
 */
import { describe, expect, it } from "bun:test";
import { type ClosableIntelligenceIndex, FallbackCodeIntelligenceIndex } from "../../src/code-intelligence/fallback-code-intelligence-index.ts";
import type { IntelligenceProvenance } from "../../src/code-intelligence/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../../src/code-intelligence/port.ts";

const PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "stub-server",
	languageId: "test",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

function stubPrimary(
	releaseFile?: (path: string) => Promise<void>,
	notifyFileChanged?: (event: { path: string; kind: "created" | "modified" | "deleted" }) => void,
): ClosableIntelligenceIndex & CodeIntelligencePort {
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
		notifyFileChanged,
		close: async () => {},
	};
}

describe("FallbackCodeIntelligenceIndex processId forwarding", () => {
	it("forwards the primary's real processId -- process-cost calibration samples the primary's subprocess, never a fallback's", () => {
		const primary = { ...stubPrimary(), processId: 4242 };
		const index = new FallbackCodeIntelligenceIndex(primary, []);

		expect(index.processId).toBe(4242);
	});

	it("is undefined when the primary has no subprocess of its own", () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(), []);

		expect(index.processId).toBeUndefined();
	});
});

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

describe("FallbackCodeIntelligenceIndex notifyFileChanged delegation", () => {
	it("delegates to the primary when it implements notifyFileChanged", () => {
		const notified: Array<{ path: string; kind: string }> = [];
		const primary = stubPrimary(undefined, (event) => notified.push(event));
		const index = new FallbackCodeIntelligenceIndex(primary, []);

		index.notifyFileChanged?.({ path: "a.ts", kind: "modified" });

		expect(notified).toEqual([{ path: "a.ts", kind: "modified" }]);
	});

	it("is a safe no-op when the primary does not implement notifyFileChanged", () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(undefined, undefined), []);

		expect(() => index.notifyFileChanged?.({ path: "a.ts", kind: "modified" })).not.toThrow();
	});
});

describe("FallbackCodeIntelligenceIndex documentHighlights delegation", () => {
	it("delegates documentHighlights to the primary when it implements it -- a real, live gap found and fixed after workspace.documentHighlights was added: this wrapper predates the port method and TypeScript's own optional-member typing let it silently satisfy CodeIntelligencePort without forwarding it", async () => {
		const highlight = { range: { path: "a.ts", start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, kind: "read" as const };
		const primary = { ...stubPrimary(), documentHighlights: async () => [highlight] };
		const index = new FallbackCodeIntelligenceIndex(primary, []);

		await expect(index.documentHighlights?.({ path: "a.ts", line: 1, character: 1 })).resolves.toEqual([highlight]);
	});

	it("resolves to an empty array when the primary does not implement documentHighlights, matching prepareRename's own degrade-not-throw precedent", async () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(), []);

		await expect(index.documentHighlights?.({ path: "a.ts", line: 1, character: 1 })).resolves.toEqual([]);
	});
});

describe("FallbackCodeIntelligenceIndex rename delegation", () => {
	it("delegates prepareRename to the primary when it implements it", async () => {
		const primary = { ...stubPrimary(), prepareRename: async () => ({ range: undefined, placeholder: undefined }) };
		const index = new FallbackCodeIntelligenceIndex(primary, []);

		await expect(index.prepareRename({ path: "a.ts", line: 1, character: 1 })).resolves.toEqual({ range: undefined, placeholder: undefined });
	});

	it("resolves to null when the primary does not implement prepareRename", async () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(), []);

		await expect(index.prepareRename({ path: "a.ts", line: 1, character: 1 })).resolves.toBeNull();
	});

	it("delegates rename to the primary when it implements it", async () => {
		const edit = { operations: [] };
		const primary = { ...stubPrimary(), rename: async () => edit };
		const index = new FallbackCodeIntelligenceIndex(primary, []);

		await expect(index.rename({ path: "a.ts", line: 1, character: 1 }, "newName")).resolves.toBe(edit);
	});

	it("throws when the primary does not implement rename, rather than silently no-opping an action the caller explicitly requested", async () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(), []);

		await expect(index.rename({ path: "a.ts", line: 1, character: 1 }, "newName")).rejects.toThrow(/does not support rename/);
	});

	it("delegates notifyFilesWillRename/notifyFilesDidRename to the primary when it implements them", async () => {
		const willCalls: unknown[] = [];
		const didCalls: unknown[] = [];
		const primary = {
			...stubPrimary(),
			notifyFilesWillRename: async (pairs: unknown) => {
				willCalls.push(pairs);
			},
			notifyFilesDidRename: (pairs: unknown) => {
				didCalls.push(pairs);
			},
		};
		const index = new FallbackCodeIntelligenceIndex(primary, []);
		const pairs = [{ fromPath: "a.ts", toPath: "b.ts" }];

		await index.notifyFilesWillRename(pairs);
		index.notifyFilesDidRename(pairs);

		expect(willCalls).toEqual([pairs]);
		expect(didCalls).toEqual([pairs]);
	});

	it("is a safe no-op for notifyFilesWillRename/notifyFilesDidRename when the primary does not implement them", async () => {
		const index = new FallbackCodeIntelligenceIndex(stubPrimary(), []);

		await expect(index.notifyFilesWillRename([{ fromPath: "a.ts", toPath: "b.ts" }])).resolves.toBeUndefined();
		expect(() => index.notifyFilesDidRename([{ fromPath: "a.ts", toPath: "b.ts" }])).not.toThrow();
	});
});
