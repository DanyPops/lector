/**
 * Every code-intelligence operation whose result can grow with real project size now bounds it
 * by maxResults/maxBytes, reporting truncated honestly -- live evidence: an unbounded call-
 * hierarchy query against a real project returned dozens of framework/stdlib entries with no way
 * for a caller to ask for fewer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

/** One "hub" function called by five others and itself calling five others, plus a file with many top-level declarations and a hover target with a long doc comment. */
function buildFixture(): { root: string; hubFile: string; manyDeclsFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-code-intelligence-bounds-"));
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));

	const leafNames = Array.from({ length: 5 }, (_, index) => `leaf${index}`);
	const leaves = leafNames.map((name) => `export function ${name}(value: number): number { return value; }`).join("\n");
	const hubFile = join(root, "hub.ts");
	writeFileSync(
		hubFile,
		[
			leaves,
			"",
			"/**",
			" * A very long documentation comment, repeated many times over, so hover's own returned",
			" * text comfortably exceeds a small byte budget in a real test without needing megabytes",
			" * of fixture content -- every one of these lines is real markdown hover content a real",
			" * language server will actually return verbatim from this exact declaration comment.",
			" */",
			`export function hub(value: number): number { return ${leafNames.map((name) => `${name}(value)`).join(" + ")}; }`,
			"",
			...Array.from({ length: 5 }, (_, index) => `export function caller${index}(value: number): number { return hub(value); }`),
		].join("\n"),
	);

	const manyDeclsFile = join(root, "many-decls.ts");
	writeFileSync(
		manyDeclsFile,
		Array.from({ length: 20 }, (_, index) => `export function decl${index}(value: number): number { return value + ${index}; }`).join("\n"),
	);

	return { root, hubFile, manyDeclsFile };
}

async function findPosition(service: LectorService, workspaceId: string, path: string, name: string): Promise<{ line: number; character: number }> {
	const { symbols } = await service.dispatch("workspace.documentSymbols", { workspaceId, path });
	const match = symbols.find((symbol) => symbol.name === name);
	if (!match) throw new Error(`no symbol named "${name}" found in ${path}`);
	return { line: match.selectionRange.start.line, character: match.selectionRange.start.character };
}

describe("workspace.incomingCalls/outgoingCalls bounds", () => {
	it("bounds incomingCalls by maxResults and reports truncated honestly", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");

		const unbounded = await service.dispatch("workspace.incomingCalls", { workspaceId, path: hubFile, ...hub });
		expect(unbounded.calls.length).toBe(5);
		expect(unbounded.truncated).toBe(false);

		const bounded = await service.dispatch("workspace.incomingCalls", { workspaceId, path: hubFile, ...hub, maxResults: 2 });
		expect(bounded.calls.length).toBe(2);
		expect(bounded.truncated).toBe(true);
	}, 30_000);

	it("bounds outgoingCalls by maxResults and reports truncated honestly", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");

		const unbounded = await service.dispatch("workspace.outgoingCalls", { workspaceId, path: hubFile, ...hub });
		expect(unbounded.calls.length).toBe(5);
		expect(unbounded.truncated).toBe(false);

		const bounded = await service.dispatch("workspace.outgoingCalls", { workspaceId, path: hubFile, ...hub, maxResults: 2 });
		expect(bounded.calls.length).toBe(2);
		expect(bounded.truncated).toBe(true);
	}, 30_000);

	it("rejects maxResults 0 the same way workspace.findSymbols already rejects an invalid bound", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");

		await expect(service.dispatch("workspace.incomingCalls", { workspaceId, path: hubFile, ...hub, maxResults: 0 })).rejects.toThrow(TypeError);
	}, 30_000);
});

describe("workspace.documentSymbols bounds", () => {
	it("bounds by maxResults and reports truncated honestly", async () => {
		const { root, manyDeclsFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const unbounded = await service.dispatch("workspace.documentSymbols", { workspaceId, path: manyDeclsFile });
		expect(unbounded.symbols.length).toBe(20);
		expect(unbounded.truncated).toBe(false);

		const bounded = await service.dispatch("workspace.documentSymbols", { workspaceId, path: manyDeclsFile, maxResults: 5 });
		expect(bounded.symbols.length).toBe(5);
		expect(bounded.truncated).toBe(true);
	}, 30_000);
});

describe("workspace.hover bounds", () => {
	it("bounds hover text by maxBytes and reports truncated honestly, without ever splitting a UTF-8 code point", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");

		const unbounded = await service.dispatch("workspace.hover", { workspaceId, path: hubFile, ...hub });
		expect(unbounded.hover?.contents.length).toBeGreaterThan(100);
		expect(unbounded.truncated).toBe(false);

		const bounded = await service.dispatch("workspace.hover", { workspaceId, path: hubFile, ...hub, maxBytes: 40 });
		expect(bounded.truncated).toBe(true);
		expect(Buffer.byteLength(bounded.hover?.contents ?? "", "utf8")).toBeLessThanOrEqual(40);
	}, 30_000);
});

describe("workspace.findReferences bounds", () => {
	it("bounds by maxResults and reports truncated honestly", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");

		const unbounded = await service.dispatch("workspace.findReferences", { workspaceId, path: hubFile, ...hub, includeDeclaration: false });
		expect(unbounded.locations.length).toBe(5);
		expect(unbounded.truncated).toBe(false);

		const bounded = await service.dispatch("workspace.findReferences", { workspaceId, path: hubFile, ...hub, includeDeclaration: false, maxResults: 2 });
		expect(bounded.locations.length).toBe(2);
		expect(bounded.truncated).toBe(true);
	}, 30_000);
});

describe("workspace.reachableFrom/symbolEdgesFrom/symbolEdgesTo bounds", () => {
	it("bounds reachableFrom's own symbol list by maxResults, independent of maxDepth", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const unbounded = await service.dispatch("workspace.reachableFrom", { workspaceId, path: hubFile, ...hub, maxDepth: 1, kind: "calls" });
		expect(unbounded.symbols.length).toBe(5);
		expect(unbounded.truncated).toBe(false);

		const bounded = await service.dispatch("workspace.reachableFrom", { workspaceId, path: hubFile, ...hub, maxDepth: 1, kind: "calls", maxResults: 2 });
		expect(bounded.symbols.length).toBe(2);
		expect(bounded.truncated).toBe(true);
	}, 30_000);

	it("bounds symbolEdgesFrom by maxResults", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const bounded = await service.dispatch("workspace.symbolEdgesFrom", { workspaceId, path: hubFile, ...hub, kind: "calls", maxResults: 2 });
		expect(bounded.symbols.length).toBe(2);
		expect(bounded.truncated).toBe(true);
	}, 30_000);

	it("bounds symbolEdgesTo by maxResults", async () => {
		const { root, hubFile } = buildFixture();
		fixtureRoot = root;
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const hub = await findPosition(service, workspaceId, hubFile, "hub");
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 50, maxSymbolsPerFile: 50 });

		const bounded = await service.dispatch("workspace.symbolEdgesTo", { workspaceId, path: hubFile, ...hub, kind: "calls", maxResults: 2 });
		expect(bounded.symbols.length).toBe(2);
		expect(bounded.truncated).toBe(true);
	}, 30_000);
});
