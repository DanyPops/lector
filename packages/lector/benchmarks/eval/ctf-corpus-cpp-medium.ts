/**
 * Tier-2+3 (medium/large combined, per this task's own scope note): a real, vendored snapshot of
 * libuv/libuv's own src/+include/ trees (118 files, MIT, pinned per fixture.json's own provenance
 * record). `uv__handle_init` (src/uv-common.h) is a real macro (`#define`), not a function,
 * referenced across roughly 26 real files -- renaming a widely-used macro is just as valid a
 * C-idiomatic refactor as a function rename, and this corpus has several similarly-named sibling
 * macros (uv__handle_start/_stop/_ref/_unref) that must never be touched.
 *
 * No compile_commands.json, structural checks only (fileContains/fileLacks/
 * directoryLacksIdentifier) -- applying the checkJs-noise lesson proactively, and sidestepping
 * the tier-1 C/C++ fixture's own real complication (an absolute-path compilation database can't
 * be committed verbatim).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import type { CtfTask } from "./ctf-corpus.ts";

async function walkCFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkCFiles(full)));
		else if (entry.name.endsWith(".c") || entry.name.endsWith(".h")) files.push(full);
	}
	return files;
}

function directoryLacksIdentifier(identifier: string, roots: readonly string[]): Checker {
	const pattern = new RegExp(`\\b${identifier}\\b`);
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["directoryLacksIdentifier: no workspace in CheckerContext"] };
			const offenders: string[] = [];
			for (const root of roots) {
				const files = await walkCFiles(join(workspace, root));
				for (const file of files) {
					const content = await readFile(file, "utf-8");
					if (pattern.test(content)) offenders.push(file);
				}
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

export const CTF_CORPUS_CPP_MEDIUM: readonly CtfTask[] = [
	{
		id: "rename-uv__handle_init-to-uv__handle_setup-across-src",
		category: "rename",
		prompt:
			"In this real libuv snapshot, rename the macro `uv__handle_init` defined in " +
			"src/uv-common.h to `uv__handle_setup`. Update its own #define and every real call site " +
			"anywhere under src/ or include/ -- there are roughly 26 such files. Do not rename the " +
			"similarly-named but unrelated sibling macros `uv__handle_start`, `uv__handle_stop`, " +
			"`uv__handle_ref`, or `uv__handle_unref`, defined in the same file.",
		checker: all(
			fileContains("src/uv-common.h", "#define uv__handle_setup("),
			fileLacks("src/uv-common.h", "#define uv__handle_init("),
			fileContains("src/uv-common.h", "#define uv__handle_start("),
			directoryLacksIdentifier("uv__handle_init", ["src", "include"]),
		),
	},
];
