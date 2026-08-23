/**
 * Tier-2+3 (medium/large combined, per this task's own scope note): a real, vendored snapshot of
 * prometheus/client_golang's own prometheus/ package (68 non-test files, Apache-2.0, pinned per
 * fixture.json's own provenance record). `NewDesc` (prometheus/desc.go) is referenced across
 * roughly 15 real files.
 *
 * Structural checks only (fileContains/fileLacks/directoryLacksIdentifier), not live gopls
 * diagnostics -- applying typescript-medium-axios's/typescript-large-prettier's own real
 * checkJs-noise finding proactively.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import type { CtfTask } from "./ctf-corpus.ts";

async function walkGoFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await walkGoFiles(full)));
		else if (entry.name.endsWith(".go")) files.push(full);
	}
	return files;
}

function directoryLacksIdentifier(identifier: string): Checker {
	const pattern = new RegExp(`\\b${identifier}\\b`);
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["directoryLacksIdentifier: no workspace in CheckerContext"] };
			const files = await walkGoFiles(join(workspace, "prometheus"));
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

export const CTF_CORPUS_GO_MEDIUM: readonly CtfTask[] = [
	{
		id: "rename-NewDesc-to-NewMetricDesc-across-prometheus",
		category: "rename",
		prompt:
			"In this real prometheus/client_golang snapshot, rename the exported function `NewDesc` " +
			"in prometheus/desc.go to `NewMetricDesc`. Update its declaration and every real call " +
			"site anywhere under prometheus/ -- there are roughly 15 such files. Do not rename " +
			"`NewConstMetric` or any other unrelated `New*` constructor in the same package.",
		checker: all(
			fileContains("prometheus/desc.go", "func NewMetricDesc("),
			fileLacks("prometheus/desc.go", "func NewDesc("),
			directoryLacksIdentifier("NewDesc"),
		),
	},
];
