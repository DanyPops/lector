import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { RipgrepTextSearch } from "../../src/adapters/ripgrep-text-search.ts";
import { deriveSourceManifest } from "../../src/adapters/source-manifest.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { populateSymbolGraph } from "../../src/symbol-graph/populate-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import { findPositionOf } from "../support/find-position.ts";
import {
	materializeTypeScriptReferenceFixture,
	materializeTypeScriptReferenceGitFixture,
	readTypeScriptReferenceManifest,
	type TypeScriptReferenceFixture,
} from "../support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;
let lsp: LspSymbolIndex | undefined;
let graph: InMemorySymbolGraph | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	await graph?.close();
	graph = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("TypeScript/JavaScript reference fixture system conformance", () => {
	it("supports fresh lexical discovery while respecting repository ignores", async () => {
		fixture = materializeTypeScriptReferenceGitFixture();
		const manifest = readTypeScriptReferenceManifest(fixture.root);
		const search = new RipgrepTextSearch();

		const included = await search.search(fixture.root, manifest.lexicalMarker, { maxMatches: 20, maxBytes: 20_000 });
		const ignored = await search.search(fixture.root, "FIXTURE_IGNORED_TEXT", { maxMatches: 20, maxBytes: 20_000 });

		expect(included.truncated).toBe(false);
		expect(included.matches).toContainEqual({
			path: "packages/app/src/raw-text.ts",
			lineNumber: 1,
			line: 'export const rawTextMarker = "FIXTURE_RAW_TEXT_ONLY";\n',
			matchStart: 30,
			matchEnd: 51,
		});
		expect(ignored).toEqual({ matches: [], truncated: false });
	});

	it("excludes gitignored source files from deriveSourceManifest's scanned set, closing the git-fast-path's own documented blind spot", async () => {
		fixture = materializeTypeScriptReferenceGitFixture();
		const fixtureRoot = fixture.root;
		const manifest = await deriveSourceManifest(fixtureRoot, TYPESCRIPT_DESCRIPTOR.extensions, 200, 2_000_000);
		const relativePaths = manifest.absoluteFiles.map((absolutePath) => relative(fixtureRoot, absolutePath));

		// generated/, history/, and ignored/ are all real .ts-extension paths this fixture's own
		// committed gitignore.fixture declares -- see typescript-reference-fixture.ts.
		expect(relativePaths).not.toContain("generated/client.ts");
		expect(relativePaths).not.toContain("history/v1/payment.ts");
		expect(relativePaths).not.toContain("history/v2/payment.ts");
		expect(relativePaths).not.toContain("ignored/raw-text.ts");
		// A real, un-ignored source file from the same fixture still gets scanned normally.
		expect(relativePaths).toContain("packages/app/src/checkout.ts");
	});

	it("changes the source generation fingerprint after a fixture mutation", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
		const before = await deriveSourceManifest(fixture.root, extensions, 200, 2_000_000);

		appendFileSync(join(fixture.root, "packages/app/src/stripe.ts"), "\nexport const watcherMutation = true;\n");
		const after = await deriveSourceManifest(fixture.root, extensions, 200, 2_000_000);

		expect(after.fingerprint).not.toBe(before.fingerprint);
		expect(after.absoluteFiles).toEqual(before.absoluteFiles);
	});

	it("builds a real call edge from the same fixture used by LSP and parser tests", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const checkoutFile = join(fixture.root, "packages/app/src/checkout.ts");
		lsp = new LspSymbolIndex(fixture.root, TYPESCRIPT_DESCRIPTOR, "packages/app/src/checkout.ts");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(lsp, graph, [checkoutFile], 50);
		const declaration = findPositionOf(checkoutFile, "runCheckoutTwice(processor");
		const nodeId = deriveSymbolNodeId({
			path: checkoutFile,
			line: declaration.line,
			character: declaration.character,
		});
		const callees = await graph.edgesFrom(nodeId, "calls");
		const names = await Promise.all(callees.map(async (id) => (await graph?.getNode(id))?.name));

		expect(result.filesProcessed).toBe(1);
		expect(names).toContain("runCheckout");
	}, 30_000);
});
