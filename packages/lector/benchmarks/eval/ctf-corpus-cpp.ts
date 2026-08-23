/**
 * C/C++ equivalent of ctf-corpus.ts's rename/move/extract tasks, against the real cpp-reference
 * fixture, checked via a live clangd-backed LspSymbolIndex.
 *
 * The "move" task deliberately creates a brand-new translation unit not listed in
 * compile_commands.json -- confirmed live that clangd's own fallback compile-flags inference
 * (borrowing from a sibling file's real compile command in the same directory) handles this
 * cleanly with zero spurious diagnostics, so no build-config update is required of the mutation.
 */
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { CPP_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import type { CtfTask } from "./ctf-corpus.ts";

function noCompileErrors(relativePaths: readonly string[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["noCompileErrors: no workspace in CheckerContext"] };
			const lsp = new LspSymbolIndex(workspace, CPP_DESCRIPTOR, "src/checkout.cpp");
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

export const CTF_CORPUS_CPP: readonly CtfTask[] = [
	{
		id: "rename-RunCheckout-to-ExecuteCheckout",
		category: "rename",
		prompt:
			"Rename the function `RunCheckout` in include/app/checkout.h and src/checkout.cpp to " +
			"`ExecuteCheckout`. Update every real call site, including inside `RunCheckoutTwice` in " +
			"src/checkout.cpp. Do not touch any other file.",
		checker: all(
			noCompileErrors(["include/app/checkout.h", "src/checkout.cpp"]),
			fileContains("src/checkout.cpp", "ExecuteCheckout"),
			fileLacks("src/checkout.cpp", "RunCheckout("),
		),
	},
	{
		id: "move-RunCheckoutTwice-to-new-file",
		category: "move",
		prompt:
			"Move the function `RunCheckoutTwice` out of include/app/checkout.h and src/checkout.cpp " +
			"into a new header/source pair, include/app/checkout_batch.h and src/checkout_batch.cpp. " +
			"checkout.h/checkout.cpp must no longer declare or define RunCheckoutTwice themselves. " +
			"A new .cpp file does not need any build-configuration change.",
		checker: all(
			noCompileErrors(["src/checkout.cpp", "src/checkout_batch.cpp"]),
			fileContains("src/checkout_batch.cpp", "RunCheckoutTwice"),
			fileLacks("src/checkout.cpp", "RunCheckoutTwice"),
			fileLacks("include/app/checkout.h", "RunCheckoutTwice"),
		),
	},
	{
		id: "extract-Processor-interface-from-StripeProcessor",
		category: "extract-interface",
		prompt:
			"Add a new abstract class named `Processor` to include/app/stripe.h, containing the same " +
			"pure virtual method signature as `StripeProcessor`'s `Process` method. Make " +
			"`StripeProcessor` inherit from `Processor` explicitly, in addition to " +
			"`contracts::PaymentProcessor`.",
		checker: all(
			noCompileErrors(["include/app/stripe.h", "src/stripe.cpp"]),
			fileContains("include/app/stripe.h", "class Processor", "public Processor"),
		),
	},
];
