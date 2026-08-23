/**
 * Tier-3 (large): a real, vendored snapshot of prettier/prettier's own src/ directory (530
 * files, MIT licensed, pinned per fixture.json's own provenance record) -- an order of magnitude
 * larger than the medium tier's 69-file axios snapshot, with `hasComment` (language-js/utilities/
 * comments.js) referenced from ~36 real files scattered across src/language-js/. This is the
 * tier expected to show the clearest real advantage per JetBrains Rider's own large-C#-solution
 * refactoring-skill study and RefactorBench's own large real repos.
 *
 * Intentionally one well-tested task, not a forced 2-3: the natural "move" companion candidate in
 * the same file (`getComments`) shares a private helper (`getCommentTestFunction`) with
 * `hasComment`, which stays behind -- a real, non-trivial shared-dependency complication that
 * would need its own separate design pass, not one bolted on here for category-completeness.
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
		else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
	}
	return files;
}

/** Same directoryLacks pattern as ctf-corpus-typescript-medium.ts, but word-boundary regex rather
 * than a literal substring: "hasComment" is itself a substring of the real, unrelated
 * `hasComments` (src/language-yaml/utilities.js) -- a literal-substring check would false-positive
 * on that file forever, since it never should be touched by this rename in the first place. */
function directoryLacksIdentifier(identifier: string): Checker {
	const pattern = new RegExp(`\\b${identifier}\\b`);
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["directoryLacksIdentifier: no workspace in CheckerContext"] };
			const files = await walkJsFiles(join(workspace, "src"));
			const offenders: string[] = [];
			for (const file of files) {
				const content = await readFile(file, "utf-8");
				if (pattern.test(content)) offenders.push(file);
			}
			return {
				pass: offenders.length === 0,
				score: offenders.length === 0 ? 1 : 0,
				errors: offenders.map((f) => `identifier '${identifier}' still present in ${f}`),
			};
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

export const CTF_CORPUS_TYPESCRIPT_LARGE: readonly CtfTask[] = [
	{
		id: "rename-hasComment-to-nodeHasComment-across-src",
		category: "rename",
		prompt:
			"In this real prettier `src/` snapshot, rename the exported function `hasComment` in " +
			"src/language-js/utilities/comments.js to `nodeHasComment`. Update its declaration, its " +
			"own named export statement, and every real import and call site anywhere under src/ that " +
			"imports `hasComment` from that file -- there are roughly 36 such files, mostly under " +
			"src/language-js/print/. Do not rename the unrelated `hasComments` function in " +
			"src/language-yaml/utilities.js -- that is a different function in a different language " +
			"printer, not this one.",
		checker: all(
			fileContains("src/language-js/utilities/comments.js", "nodeHasComment"),
			fileLacks("src/language-js/utilities/comments.js", "function hasComment("),
			directoryLacksIdentifier("hasComment"),
		),
	},
];
