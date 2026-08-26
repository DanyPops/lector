import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReferences } from "../../src/code-intelligence/find-references.ts";
import { CPP_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { findPositionOf } from "../support/find-position.ts";

let lsp: LspSymbolIndex | undefined;
let root: string | undefined;

afterEach(async () => {
	await lsp?.close();
	lsp = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("clangd find_references without a compilation database", () => {
	/**
	 * Characterizes a real reported gap, mirroring upstream linuxptp's own shape: a Makefile-only
	 * C project with no compile_commands.json anywhere in the tree. Without a compilation database
	 * telling clangd how bmc.h/telecom.c/clock.c relate as one translation unit, clangd falls back
	 * to single-file/generic parsing -- find_references on telecom_dscmp's own definition then
	 * misses its two real cross-file usages (a function-pointer assignment in clock.c and its own
	 * forward declaration in bmc.h), with nothing in the response signaling the degraded scope.
	 * Update or remove this test once Lector's clangd descriptor surfaces indexScope provenance
	 * for the no-database case (see the sibling "make clangd consume safe existing build context"
	 * work this depends on).
	 */
	it("returns only the declaration site, missing the cross-file function-pointer usage and forward declaration", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-cpp-no-db-repro-"));
		const projectRoot = root;
		writeFileSync(
			join(projectRoot, "bmc.h"),
			["struct dataset { int priority; };", "", "int telecom_dscmp(struct dataset *a, struct dataset *b);", ""].join("\n"),
		);
		writeFileSync(
			join(projectRoot, "telecom.c"),
			['#include "bmc.h"', "", "int telecom_dscmp(struct dataset *a, struct dataset *b)", "{", "\treturn a->priority - b->priority;", "}", ""].join("\n"),
		);
		writeFileSync(
			join(projectRoot, "clock.c"),
			[
				'#include "bmc.h"',
				"",
				"struct clock {",
				"\tint (*dscmp)(struct dataset *a, struct dataset *b);",
				"};",
				"",
				"void clock_init(struct clock *c)",
				"{",
				"\tc->dscmp = telecom_dscmp;",
				"}",
				"",
			].join("\n"),
		);

		const telecomFile = join(projectRoot, "telecom.c");
		lsp = new LspSymbolIndex(projectRoot, CPP_DESCRIPTOR, "telecom.c");
		const definition = findPositionOf(telecomFile, "telecom_dscmp");
		const references = await findReferences(lsp, { path: telecomFile, line: definition.line, character: definition.character }, true);

		expect(references).toEqual([{ path: telecomFile, line: definition.line, character: definition.character }]);
		expect(references.some((location) => location.path === join(projectRoot, "clock.c"))).toBe(false);
		expect(references.some((location) => location.path === join(projectRoot, "bmc.h"))).toBe(false);
	}, 30_000);
});
