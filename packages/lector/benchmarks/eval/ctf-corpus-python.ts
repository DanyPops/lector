/**
 * Python equivalent of ctf-corpus.ts's rename/move/extract tasks, against the real
 * python-reference fixture, checked via a live pyright-backed LspSymbolIndex rather than a bare
 * CLI invocation -- same rationale as the TypeScript corpus: the real language server resolves
 * this fixture's own package layout correctly where a standalone CLI check would need its own
 * separate config wiring.
 */
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { PYTHON_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import type { CtfTask } from "./ctf-corpus.ts";

function noCompileErrors(relativePaths: readonly string[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["noCompileErrors: no workspace in CheckerContext"] };
			const lsp = new LspSymbolIndex(workspace, PYTHON_DESCRIPTOR, "app/checkout.py");
			try {
				const errors: string[] = [];
				for (const relativePath of relativePaths) {
					const reported = await diagnostics(lsp, join(workspace, relativePath));
					for (const diagnostic of reported) {
						if (diagnostic.severity === "error") errors.push(`${relativePath}: ${diagnostic.message}`);
					}
				}
				return { pass: errors.length === 0, score: errors.length === 0 ? 1 : 0, errors };
			} finally {
				await lsp.close();
			}
		},
	};
}

function fileLacks(relativePath: string, forbidden: string): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["fileLacks: no workspace in CheckerContext"] };
			const { readFile } = await import("node:fs/promises");
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

export const CTF_CORPUS_PYTHON: readonly CtfTask[] = [
	{
		id: "rename-run_checkout-to-execute_checkout",
		category: "rename",
		prompt:
			"Rename the function `run_checkout` in app/checkout.py to `execute_checkout`. " +
			"Update every real call site, including inside `run_checkout_twice` in the same file. " +
			"Do not touch any other file.",
		checker: all(
			noCompileErrors(["app/checkout.py"]),
			fileContains("app/checkout.py", "execute_checkout"),
			fileLacks("app/checkout.py", "run_checkout("),
		),
	},
	{
		id: "move-run_checkout_twice-to-new-file",
		category: "move",
		prompt:
			"Move the function `run_checkout_twice` out of app/checkout.py into a new file " +
			"app/checkout_batch.py, exporting it from there. Fix imports so both files still work -- " +
			"checkout.py must no longer define run_checkout_twice itself.",
		checker: all(
			noCompileErrors(["app/checkout.py", "app/checkout_batch.py"]),
			fileContains("app/checkout_batch.py", "run_checkout_twice"),
			fileLacks("app/checkout.py", "def run_checkout_twice"),
		),
	},
	{
		id: "extract-protocol-from-StripeProcessor",
		category: "extract-interface",
		prompt:
			"Extract a new typing.Protocol named `Processor` from the class `StripeProcessor` in " +
			"app/stripe.py, containing its `process` method signature. Make `StripeProcessor` " +
			"structurally satisfy `Processor` (Protocol conformance is structural in Python -- no " +
			"explicit base-class change is required, but the Protocol itself must exist in the file).",
		checker: all(noCompileErrors(["app/stripe.py"]), fileContains("app/stripe.py", "class Processor", "Protocol")),
	},
];
