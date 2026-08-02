/**
 * Regression coverage for CodeGraph's real #2103 shape: a deleted file's symbol-graph nodes and
 * the edges pointing at them must not survive a regeneration, AND the fix must hold across a
 * SECOND consecutive regeneration after the deletion, not just the first -- CodeGraph's own bug
 * (a purge whose own follow-up recompute step erased the very record the first fix introduced)
 * was specifically a "works once, breaks on repeat" failure. Uses an injected in-memory
 * SymbolGraphPort kept by direct reference so node/edge state can be inspected after each
 * regeneration, not just inferred from call counts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutgoingCall } from "../src/domain/call-hierarchy.ts";
import type { DocumentSymbolEntry } from "../src/domain/document-symbol.ts";
import type { IntelligenceProvenance } from "../src/domain/intelligence-provenance.ts";
import type { CodeIntelligencePort } from "../src/ports/code-intelligence-port.ts";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService } from "../src/service.ts";
import { InMemorySymbolGraph } from "../src/symbol-graph/in-memory-symbol-graph.ts";

const PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "stub-server",
	languageId: "typescript",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("symbol-graph regeneration purges files that disappeared since the previous generation", () => {
	it("removes a deleted file's node and the edge into it, and stays purged across a second consecutive regeneration", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-graph-purge-"));
		const aPath = join(root, "a.ts");
		const bPath = join(root, "b.ts");
		writeFileSync(aPath, "export function callerFn() { calleeFn(); }\n");
		writeFileSync(bPath, "export function calleeFn() {}\n");
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));

		const callerSelectionRange = { path: aPath, start: { line: 1, character: 17 }, end: { line: 1, character: 17 } };
		const calleeSelectionRange = { path: bPath, start: { line: 1, character: 17 }, end: { line: 1, character: 17 } };
		const calleeLocation = { path: bPath, line: 1, character: 17 };
		const callerNodeId = `${aPath}:1:17`;
		const calleeNodeId = `${bPath}:1:17`;

		let bDeleted = false;
		const graph = new InMemorySymbolGraph();
		const index: ClosableSymbolIndex & CodeIntelligencePort = {
			provenance: PROVENANCE,
			findSymbols: async () => ({ symbols: [], truncated: false, provenance: PROVENANCE }),
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async (path: string): Promise<DocumentSymbolEntry[]> => {
				if (path === aPath) return [{ name: "callerFn", kind: "function", range: callerSelectionRange, selectionRange: callerSelectionRange }];
				if (path === bPath) return [{ name: "calleeFn", kind: "function", range: calleeSelectionRange, selectionRange: calleeSelectionRange }];
				return [];
			},
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async (location): Promise<OutgoingCall[]> => {
				if (location.path === aPath && !bDeleted) {
					return [{ to: { name: "calleeFn", kind: "function", location: calleeLocation, range: calleeSelectionRange }, fromRanges: [] }];
				}
				return [];
			},
			releaseFile: async () => {},
			notifyFileChanged: () => {},
			close: async () => {},
		};

		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => index, createSymbolGraph: () => graph });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(await graph.getNode(callerNodeId)).toBeDefined();
		expect(await graph.getNode(calleeNodeId)).toBeDefined();
		expect(await graph.edgesFrom(callerNodeId, "calls")).toEqual([calleeNodeId]);

		// The deletion this test is really about.
		unlinkSync(bPath);
		bDeleted = true;

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(await graph.getNode(callerNodeId)).toBeDefined();
		expect(await graph.getNode(calleeNodeId)).toBeUndefined();
		expect(await graph.edgesFrom(callerNodeId, "calls")).toEqual([]);

		// The second consecutive regeneration after the deletion -- CodeGraph's own #2103 bug was
		// specifically that a fix's own follow-up run undid itself here.
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(await graph.getNode(callerNodeId)).toBeDefined();
		expect(await graph.getNode(calleeNodeId)).toBeUndefined();
		expect(await graph.edgesFrom(callerNodeId, "calls")).toEqual([]);
	});
});
