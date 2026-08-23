/**
 * Go equivalent of ctf-corpus.ts's rename/move/extract tasks, against the real go-reference
 * fixture, checked via a live gopls-backed LspSymbolIndex.
 */
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { GO_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import type { CtfTask } from "./ctf-corpus.ts";

function noCompileErrors(relativePaths: readonly string[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["noCompileErrors: no workspace in CheckerContext"] };
			const lsp = new LspSymbolIndex(workspace, GO_DESCRIPTOR, "app/checkout.go");
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

export const CTF_CORPUS_GO: readonly CtfTask[] = [
	{
		id: "rename-RunCheckout-to-ExecuteCheckout",
		category: "rename",
		prompt:
			"Rename the function `RunCheckout` in app/checkout.go to `ExecuteCheckout`. " +
			"Update every real call site, including inside `RunCheckoutTwice` in the same file. " +
			"Do not touch any other file.",
		checker: all(
			noCompileErrors(["app/checkout.go"]),
			fileContains("app/checkout.go", "ExecuteCheckout"),
			fileLacks("app/checkout.go", "RunCheckout("),
		),
	},
	{
		id: "move-RunCheckoutTwice-to-new-file",
		category: "move",
		prompt:
			"Move the function `RunCheckoutTwice` out of app/checkout.go into a new file " +
			"app/checkout_batch.go (same `package app`), keeping it exported. " +
			"checkout.go must no longer define RunCheckoutTwice itself.",
		checker: all(
			noCompileErrors(["app/checkout.go", "app/checkout_batch.go"]),
			fileContains("app/checkout_batch.go", "RunCheckoutTwice"),
			fileLacks("app/checkout.go", "func RunCheckoutTwice"),
		),
	},
	{
		id: "extract-Processor-interface-from-StripeProcessor",
		category: "extract-interface",
		prompt:
			"Add a new interface named `Processor` to app/stripe.go, containing the same method " +
			"signature as `StripeProcessor`'s `Process` method. Go interfaces are always structural " +
			"-- `StripeProcessor` already satisfies it once the method signature matches, no explicit " +
			"declaration is required beyond defining the interface itself.",
		checker: all(noCompileErrors(["app/stripe.go"]), fileContains("app/stripe.go", "type Processor interface")),
	},
];
