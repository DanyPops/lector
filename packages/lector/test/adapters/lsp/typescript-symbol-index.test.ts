/**
 * Dogfood: a real typescript-language-server process, queried against
 * Lector's own source tree, not a fixture. The same dogfood pattern
 * extends to goToDefinition/findReferences/hover/documentSymbols.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypescriptSymbolIndex } from "../../../src/adapters/lsp/typescript-symbol-index.ts";
import { diagnostics } from "../../../src/domain/diagnostics.ts";
import { documentSymbols } from "../../../src/domain/document-symbols.ts";
import { incomingCalls } from "../../../src/domain/incoming-calls.ts";
import { outgoingCalls } from "../../../src/domain/outgoing-calls.ts";
import { prepareCallHierarchy } from "../../../src/domain/prepare-call-hierarchy.ts";
import { findReferences } from "../../../src/domain/find-references.ts";
import { findWorkspaceSymbols } from "../../../src/domain/find-workspace-symbols.ts";
import { goToDefinition } from "../../../src/domain/go-to-definition.ts";
import { hoverAt } from "../../../src/domain/hover-at.ts";
import { findPositionOf } from "../../support/find-position.ts";

const LECTOR_ROOT = new URL("../../..", import.meta.url).pathname;
const EXACT_EDIT_FILE = join(LECTOR_ROOT, "src/domain/exact-edit.ts");
const SERVICE_FILE = join(LECTOR_ROOT, "src/service.ts");
const FIND_WORKSPACE_SYMBOLS_FILE = join(LECTOR_ROOT, "src/domain/find-workspace-symbols.ts");
const SYMBOL_INDEX_PORT_FILE = join(LECTOR_ROOT, "src/ports/symbol-index-port.ts");
const TYPESCRIPT_SYMBOL_INDEX_FILE = join(LECTOR_ROOT, "src/adapters/lsp/typescript-symbol-index.ts");

let index: TypescriptSymbolIndex | undefined;
afterEach(async () => {
	await index?.close();
	index = undefined;
});

describe("TypescriptSymbolIndex", () => {
	it("finds a real, known symbol in Lector's own source via a live typescript-language-server", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");

		const results = await findWorkspaceSymbols(index, "exactEdit");

		// Real tsserver behavior, not an assumption: navto only surfaces symbols in files it
		// has actually loaded. With only the seed file (src/index.ts) opened, the match found
		// is the barrel's re-export binding (kind "variable"), not exact-edit.ts's original
		// `function` declaration -- tsserver never independently opened that file. Still a
		// materially useful result: it correctly names and locates the symbol.
		const match = results.find((symbol) => symbol.name === "exactEdit");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("lector");
		expect(match?.location.line).toBeGreaterThan(0);
	}, 20_000);

	it("returns an empty array for a query matching nothing, not an error", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");

		const results = await findWorkspaceSymbols(index, "ThisSymbolDefinitelyDoesNotExistAnywhere");

		expect(results).toEqual([]);
	}, 20_000);

	it("goToDefinition navigates a method-access usage to the interface member that declares it", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		// find-workspace-symbols.ts's own body calls index.findSymbols(query), where `index` is
		// typed SymbolIndexPort -- a real cross-file member access, not a plain imported-value
		// usage. Real, confirmed tsserver behavior (not assumed): a plain value-import usage's
		// definition stops at the local import specifier in the SAME file rather than crossing
		// into the exporting module (typescript-language-server has no standard-LSP way to force
		// the deeper "go to source definition" hop editors like VS Code offer as an extra command);
		// a member-access call like this one does cross files correctly.
		const usage = findPositionOf(FIND_WORKSPACE_SYMBOLS_FILE, ".findSymbols(query)");

		const locations = await goToDefinition(index, { path: FIND_WORKSPACE_SYMBOLS_FILE, line: usage.line, character: usage.character + 2 });

		expect(locations.length).toBeGreaterThan(0);
		expect(locations[0]?.path).toBe(SYMBOL_INDEX_PORT_FILE);
	}, 20_000);

	it("findReferences reliably finds usages within the seed file's own transitive import graph", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		const declaration = findPositionOf(EXACT_EDIT_FILE, "export async function exactEdit");
		// Position on the identifier itself, past "export async function ".
		const at = { path: EXACT_EDIT_FILE, line: declaration.line, character: declaration.character + "export async function ".length };

		const references = await findReferences(index, at, true);

		// Reliable across runs: the declaration itself, plus index.ts's own re-export of it --
		// both reachable by following the seed file's own imports. Deliberately NOT asserting
		// whether service.ts's usage (a reverse-dependent tsserver only finds once it has
		// progressed its own background project loading far enough) shows up here: confirmed
		// directly, across repeated runs, that this is genuinely timing/scheduling-sensitive --
		// not a fixed architectural limit -- so asserting either way about it would be flaky.
		// The next test shows the deterministic way to guarantee a specific file is included.
		const files = new Set(references.map((location) => location.path));
		expect(references.length).toBeGreaterThanOrEqual(2);
		expect(files.has(EXACT_EDIT_FILE)).toBe(true);
		expect(files.has(join(LECTOR_ROOT, "src/index.ts"))).toBe(true);
	}, 20_000);

	it("findReferences reliably includes a consumer file's usage once that file has itself been queried (opened)", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		// Querying documentSymbols against service.ts first makes tsserver track it immediately,
		// rather than depending on how far its own background project loading has progressed --
		// this is the deterministic, intended path: an agent that has already looked at a file
		// is guaranteed that file's usages are included, rather than references being a matter
		// of luck.
		await documentSymbols(index, SERVICE_FILE);

		const declaration = findPositionOf(EXACT_EDIT_FILE, "export async function exactEdit");
		const at = { path: EXACT_EDIT_FILE, line: declaration.line, character: declaration.character + "export async function ".length };
		const references = await findReferences(index, at, true);

		const files = new Set(references.map((location) => location.path));
		expect(files.has(SERVICE_FILE)).toBe(true);
	}, 20_000);

	it("hover returns real type/doc information for a known declaration, not an empty result", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		const declaration = findPositionOf(EXACT_EDIT_FILE, "export async function exactEdit");
		const at = { path: EXACT_EDIT_FILE, line: declaration.line, character: declaration.character + "export async function ".length };

		const hover = await hoverAt(index, at);

		expect(hover).toBeDefined();
		expect(hover?.contents.length).toBeGreaterThan(0);
		expect(hover?.contents).toContain("exactEdit");
	}, 20_000);

	it("prepareCallHierarchy resolves a real method declaration to a call-hierarchy root", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		const declaration = findPositionOf(TYPESCRIPT_SYMBOL_INDEX_FILE, "private async ensureFileOpen");
		const at = { path: TYPESCRIPT_SYMBOL_INDEX_FILE, line: declaration.line, character: declaration.character + "private async ".length };

		const roots = await prepareCallHierarchy(index, at);

		expect(roots.length).toBeGreaterThan(0);
		expect(roots[0]?.name).toBe("ensureFileOpen");
	}, 20_000);

	it("incomingCalls finds a real caller of a method used multiple times within its own declaring file", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		const declaration = findPositionOf(TYPESCRIPT_SYMBOL_INDEX_FILE, "private async ensureFileOpen");
		const at = { path: TYPESCRIPT_SYMBOL_INDEX_FILE, line: declaration.line, character: declaration.character + "private async ".length };

		const callers = await incomingCalls(index, at);

		// ensureFileOpen is called from goToDefinition, findReferences, hover, documentSymbols,
		// diagnostics, and prepareCallHierarchyRaw -- all within this same seed-reachable file.
		expect(callers.length).toBeGreaterThan(0);
		expect(callers.every((call) => call.from.location.path === TYPESCRIPT_SYMBOL_INDEX_FILE)).toBe(true);
	}, 20_000);

	it("outgoingCalls finds the real methods a function itself calls", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");
		const declaration = findPositionOf(TYPESCRIPT_SYMBOL_INDEX_FILE, "async diagnostics(path");
		const at = { path: TYPESCRIPT_SYMBOL_INDEX_FILE, line: declaration.line, character: declaration.character + "async ".length };

		const callees = await outgoingCalls(index, at);

		// diagnostics() calls ensureInitialized, ensureFileOpen, and waitForDiagnosticsNotification.
		const names = callees.map((call) => call.to.name);
		expect(names).toContain("ensureFileOpen");
	}, 20_000);

	it("prepareCallHierarchy returns an empty array for a position with no resolvable symbol, not an error", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");

		const roots = await prepareCallHierarchy(index, { path: TYPESCRIPT_SYMBOL_INDEX_FILE, line: 1, character: 1 });

		expect(roots).toEqual([]);
	}, 20_000);

	it("documentSymbols lists the declarations of one specific file directly, with the real declaration kind", async () => {
		index = new TypescriptSymbolIndex(LECTOR_ROOT, "src/index.ts");

		const symbols = await documentSymbols(index, EXACT_EDIT_FILE);

		const exactEditEntry = symbols.find((symbol) => symbol.name === "exactEdit");
		expect(exactEditEntry).toBeDefined();
		// Queried directly against its declaring file (not a workspace/symbol search hitting a
		// barrel's re-export binding), this must be the real function declaration.
		expect(exactEditEntry?.kind).toBe("function");
		expect(exactEditEntry?.range.path).toBe(EXACT_EDIT_FILE);
	}, 20_000);
});

describe("TypescriptSymbolIndex diagnostics", () => {
	// A real type error can't live in this project's own tracked source (it would break this
	// project's own typecheck), so diagnostics needs its own throwaway fixture project rather
	// than dogfooding LECTOR_ROOT like every other test above.
	let fixtureRoot: string | undefined;

	afterEach(async () => {
		await index?.close();
		index = undefined;
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function buildFixture(): string {
		const root = mkdtempSync(join(tmpdir(), "lector-diagnostics-fixture-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		writeFileSync(join(root, "broken.ts"), 'export const total: number = "not a number";\n');
		writeFileSync(join(root, "clean.ts"), "export const total: number = 1 + 1;\n");
		return root;
	}

	it("surfaces a real type error as an error-severity diagnostic", async () => {
		fixtureRoot = buildFixture();
		index = new TypescriptSymbolIndex(fixtureRoot, "broken.ts");

		const results = await diagnostics(index, join(fixtureRoot, "broken.ts"));

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.severity).toBe("error");
		expect(results[0]?.message).toContain("not assignable");
		expect(results[0]?.range.path).toBe(join(fixtureRoot, "broken.ts"));
	}, 20_000);

	it("returns an empty array for a file with no issues, not a fabricated result", async () => {
		fixtureRoot = buildFixture();
		index = new TypescriptSymbolIndex(fixtureRoot, "broken.ts");

		const results = await diagnostics(index, join(fixtureRoot, "clean.ts"));

		expect(results).toEqual([]);
	}, 20_000);

	it("keeps two files' diagnostics independent -- querying one never leaks the other's issues", async () => {
		fixtureRoot = buildFixture();
		index = new TypescriptSymbolIndex(fixtureRoot, "broken.ts");

		const brokenResults = await diagnostics(index, join(fixtureRoot, "broken.ts"));
		const cleanResults = await diagnostics(index, join(fixtureRoot, "clean.ts"));

		expect(brokenResults.length).toBeGreaterThan(0);
		expect(cleanResults).toEqual([]);
	}, 20_000);
});
