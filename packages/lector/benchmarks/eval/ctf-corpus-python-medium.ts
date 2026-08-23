/**
 * Tier-2+3 (medium/large combined, per this task's own scope note): a real, vendored snapshot of
 * celery/celery's own celery/ package (161 files, BSD-3, pinned per fixture.json's own provenance
 * record). `current_app` (celery/_state.py) is referenced across roughly a dozen real files,
 * including celery/__init__.py's own lazy-module attribute mapping (`local.recreate_module`) --
 * a real, genuinely trickier rename than a plain import list, since a mismatch there breaks
 * `from celery import current_app` at runtime, not just at static-analysis time.
 *
 * Structural checks only (fileContains/fileLacks/directoryLacksIdentifier), not live diagnostics
 * -- applying typescript-medium-axios's/typescript-large-prettier's own real checkJs-noise
 * finding proactively rather than re-discovering it against pyright.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import type { CtfTask } from "./ctf-corpus.ts";

async function walkPyFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkPyFiles(full)));
		else if (entry.name.endsWith(".py")) files.push(full);
	}
	return files;
}

function directoryLacksIdentifier(identifier: string): Checker {
	const pattern = new RegExp(`\\b${identifier}\\b`);
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["directoryLacksIdentifier: no workspace in CheckerContext"] };
			const files = await walkPyFiles(join(workspace, "celery"));
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

export const CTF_CORPUS_PYTHON_MEDIUM: readonly CtfTask[] = [
	{
		id: "rename-current_app-to-active_app-across-celery",
		category: "rename",
		prompt:
			"In this real celery snapshot, rename the module-level `current_app` proxy defined in " +
			"celery/_state.py to `active_app`. Update its declaration, every real import and usage " +
			"anywhere under celery/, AND celery/__init__.py's own lazy-module attribute mapping " +
			"(the `by_module={'celery._state': ['current_app', 'current_task'], ...}` dict, and the " +
			"`__all__`-style string list above it) -- a stale entry there breaks " +
			"`from celery import current_app` at runtime, not just at static-analysis time. Do not " +
			"rename `current_task`, a different proxy in the same file.",
		checker: all(
			fileContains("celery/_state.py", "active_app"),
			fileLacks("celery/_state.py", "current_app = Proxy("),
			directoryLacksIdentifier("current_app"),
		),
	},
];
