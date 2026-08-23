/**
 * CTF-style symbol-manipulation tasks (rename/move/extract) against a real materialized
 * typescript-reference fixture, each with a real outcome checker: does it still really compile
 * (via a genuine LspSymbolIndex + real tsserver diagnostics, not a raw `tsc` CLI invocation --
 * this fixture's own composite project references and intentionally-broken files, e.g.
 * type-error.ts/view.tsx, make a bare `tsc --noEmit -p` unusable as a clean baseline; the real
 * language server resolves project references/paths/JSX correctly where the CLI alone doesn't),
 * and did the real mutation actually happen (the right content present, the old content gone
 * where it should be).
 *
 * Task format modeled on microsoft/RefactorBench's own real corpus (github.com/microsoft/
 * RefactorBench, problems/base_problems/<repo>/<slug>-task.txt + tests/<repo>/<slug>-test.py):
 * one natural-language instruction, one real automated check that the mutation happened
 * correctly -- adapted here to TypeScript compiler/content checks instead of Python AST checks.
 */
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";

/** A Checker asserting a real LSP boot reports zero error-severity diagnostics for the given files. */
function noCompileErrors(relativePaths: readonly string[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["noCompileErrors: no workspace in CheckerContext"] };
			const lsp = new LspSymbolIndex(workspace, TYPESCRIPT_DESCRIPTOR, "packages/app/src/main.ts");
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

/** A Checker asserting a file does NOT contain a given substring -- complements pi-eval-harness's own fileContains, for "the old name/definition is really gone" assertions a move/rename task needs. */
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
			if (content.includes(forbidden)) {
				return { pass: false, score: 0, errors: [`'${forbidden}' still present in ${relativePath}`] };
			}
			return { pass: true, score: 1, errors: [] };
		},
	};
}

export interface CtfTask {
	readonly id: string;
	readonly category: "rename" | "move" | "extract-interface";
	readonly prompt: string;
	readonly checker: Checker;
}

export const CTF_CORPUS: readonly CtfTask[] = [
	{
		id: "rename-runCheckout-to-executeCheckout",
		category: "rename",
		prompt:
			"Rename the function `runCheckout` in packages/app/src/checkout.ts to `executeCheckout`. " +
			"Update every real call site, including inside `runCheckoutTwice` in the same file.",
		checker: all(
			noCompileErrors(["packages/app/src/checkout.ts"]),
			fileContains("packages/app/src/checkout.ts", "executeCheckout"),
			fileLacks("packages/app/src/checkout.ts", "runCheckout("),
		),
	},
	{
		id: "move-runCheckoutTwice-to-new-file",
		category: "move",
		prompt:
			"Move the function `runCheckoutTwice` out of packages/app/src/checkout.ts into a new file " +
			"packages/app/src/checkout-batch.ts, exporting it from there. Fix imports so both files still " +
			"compile -- checkout.ts must no longer define runCheckoutTwice itself. Import runCheckout into " +
			'the new file with no file extension (e.g. `from "./checkout"`), not a `.ts` extension.',
		checker: all(
			noCompileErrors(["packages/app/src/checkout.ts", "packages/app/src/checkout-batch.ts"]),
			fileContains("packages/app/src/checkout-batch.ts", "runCheckoutTwice"),
			fileLacks("packages/app/src/checkout.ts", "function runCheckoutTwice"),
		),
	},
	{
		id: "extract-interface-from-StripeProcessor",
		category: "extract-interface",
		prompt:
			"Extract a new interface named `Processor` from the class `StripeProcessor` in " +
			"packages/app/src/stripe.ts, containing its `process` method signature. Make `StripeProcessor` " +
			"implement `Processor` explicitly, in addition to `PaymentProcessor`.",
		checker: all(
			noCompileErrors(["packages/app/src/stripe.ts"]),
			fileContains("packages/app/src/stripe.ts", "interface Processor", "implements"),
		),
	},
];
