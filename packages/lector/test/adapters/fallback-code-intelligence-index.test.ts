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
