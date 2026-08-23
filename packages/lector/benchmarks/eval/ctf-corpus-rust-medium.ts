/**
 * Tier-2+3 (medium/large combined, per this task's own scope note): a real, vendored snapshot of
 * BurntSushi/ripgrep's own crates/ workspace (90 files, MIT, pinned per fixture.json's own
 * provenance record). `SearcherBuilder` (crates/searcher) is referenced across real consumer
 * crates (core, printer, grep's own example) -- a genuine cross-crate rename, not just cross-file
 * within one crate, the real complication a multi-crate Cargo workspace adds over a single-crate
 * fixture.
 *
 * Structural checks only (fileContains/fileLacks/directoryLacksIdentifier), not live
 * rust-analyzer diagnostics -- applying the checkJs-noise lesson proactively.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import type { CtfTask } from "./ctf-corpus.ts";

async function walkRsFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkRsFiles(full)));
		else if (entry.name.endsWith(".rs")) files.push(full);
	}
	return files;
}

function directoryLacksIdentifier(identifier: string): Checker {
	const pattern = new RegExp(`\\b${identifier}\\b`);
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["directoryLacksIdentifier: no workspace in CheckerContext"] };
			const files = await walkRsFiles(join(workspace, "crates"));
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

export const CTF_CORPUS_RUST_MEDIUM: readonly CtfTask[] = [
	{
		id: "rename-SearcherBuilder-to-SearchEngineBuilder-across-crates",
		category: "rename",
		prompt:
			"In this real ripgrep crates/ snapshot, rename the exported struct `SearcherBuilder` in " +
			"crates/searcher/src/searcher/mod.rs to `SearchEngineBuilder`. Update its declaration and " +
			"every real reference anywhere under crates/ -- this struct is used across several " +
			"different crates (core, printer, and grep's own example), not just within the " +
			"searcher crate itself. Do not rename the unrelated `Searcher` struct in the same file.",
		checker: all(
			fileContains("crates/searcher/src/searcher/mod.rs", "SearchEngineBuilder"),
			fileLacks("crates/searcher/src/searcher/mod.rs", "struct SearcherBuilder"),
			directoryLacksIdentifier("SearcherBuilder"),
		),
	},
];
