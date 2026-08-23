/**
 * Tier-2 (medium): CTF tasks against a real, vendored snapshot of axios/axios's own lib/
 * directory (69 files, MIT licensed, pinned per fixture.json's own provenance record) --
 * unlike ctf-corpus.ts's small hand-crafted fixture, `forEach` here has ~19 real internal call
 * sites scattered across lib/, the exact regime (JetBrains Rider's own refactoring-skill study,
 * RefactorBench) where a baseline arm can no longer just read 2-3 files and must search broadly.
 */
/**
 * Unlike the small hand-crafted reference fixtures, a real OSS codebase's own pre-existing
 * checkJs noise swamps any real mutation signal -- confirmed live: enabling checkJs against this
 * repo's own real, complex, previously-untyped source produced dozens of type errors entirely
 * unrelated to any mutation (e.g. "Property 'unsubscribe' does not exist on type 'AbortSignal'").
 * checkJs is deliberately off in this fixture's own jsconfig.json; correctness here is checked
 * structurally (fileContains/fileLacks/directoryLacks) rather than via compiler diagnostics.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import type { CtfTask } from "./ctf-corpus.ts";

async function walkJsFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkJsFiles(full)));
		else if (entry.name.endsWith(".js")) files.push(full);
	}
	return files;
}

/** Asserts NO file anywhere under lib/ still contains `forbidden` -- the real, broad completeness
 * check this tier exists to exercise (unlike a small fixture's own hand-enumerated fileLacks
 * calls, this doesn't require knowing all ~19 real call sites' exact paths up front). */
function directoryLacks(forbidden: string): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["directoryLacks: no workspace in CheckerContext"] };
			const files = await walkJsFiles(join(workspace, "lib"));
			const offenders: string[] = [];
			for (const file of files) {
				const content = await readFile(file, "utf-8");
				if (content.includes(forbidden)) offenders.push(file);
			}
			return { pass: offenders.length === 0, score: offenders.length === 0 ? 1 : 0, errors: offenders.map((f) => `'${forbidden}' still present in ${f}`) };
		},
	};
}

function fileLacks(relativePath: string, forbidden: string): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["fileLacks: no workspace in CheckerContext"] };
			let content: string;
			try {
				content = await readFile(join(workspace, relativePath), "utf-8");
			} catch {
				return { pass: false, score: 0, errors: [`File not found: ${relativePath}`] };
			}
			if (content.includes(forbidden)) return { pass: false, score: 0, errors: [`'${forbidden}' still present in ${relativePath}`] };
			return { pass: true, score: 1, errors: [] };
		},
	};
}

export const CTF_CORPUS_TYPESCRIPT_MEDIUM: readonly CtfTask[] = [
	{
		id: "rename-forEach-to-iterateEach-across-lib",
		category: "rename",
		prompt:
			"In this real axios `lib/` snapshot, rename the exported utility function `forEach` in " +
			"lib/utils.js to `iterateEach`. Update its declaration, every internal call site within " +
			"utils.js itself, the property name in utils.js's own default export object, and every " +
			"real external call site anywhere under lib/ that calls `utils.forEach(...)` -- there are " +
			"roughly 19 such files. Do not rename any other, unrelated `forEach` (e.g. a native " +
			"Array.prototype.forEach call) -- only this specific exported utility.",
		checker: all(
			fileContains("lib/utils.js", "iterateEach"),
			fileLacks("lib/utils.js", "function forEach("),
			directoryLacks("utils.forEach("),
		),
	},
	{
		id: "move-isSpecCompliantForm-to-new-file",
		category: "move",
		prompt:
			"Move the function `isSpecCompliantForm` out of lib/utils.js into a new file " +
			"lib/helpers/isSpecCompliantForm.js, exporting it as the default export from there. " +
			"Update lib/utils.js to import it from the new file and still include it (under the same " +
			"name) in its own default export object, so every existing `utils.isSpecCompliantForm(...)` " +
			"call site keeps working unchanged. lib/utils.js must no longer define the function itself.",
		checker: all(
			fileContains("lib/helpers/isSpecCompliantForm.js", "isSpecCompliantForm"),
			fileLacks("lib/utils.js", "function isSpecCompliantForm"),
			fileContains("lib/utils.js", "isSpecCompliantForm"),
		),
	},
];
