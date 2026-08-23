/**
 * Rust equivalent of ctf-corpus.ts's rename/move/extract tasks, against the real rust-reference
 * fixture, checked via a live rust-analyzer-backed LspSymbolIndex.
 */
import { join } from "node:path";
import { all, type Checker, type CheckerContext, type CheckerResult, fileContains } from "@danypops/pi-eval-harness";
import { diagnostics } from "../../src/code-intelligence/diagnostics.ts";
import { RUST_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import type { CtfTask } from "./ctf-corpus.ts";

function noCompileErrors(relativePaths: readonly string[]): Checker {
	return {
		async check({ workspace }: CheckerContext): Promise<CheckerResult> {
			if (workspace === undefined) return { pass: false, score: 0, errors: ["noCompileErrors: no workspace in CheckerContext"] };
			const lsp = new LspSymbolIndex(workspace, RUST_DESCRIPTOR, "app/src/lib.rs");
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

export const CTF_CORPUS_RUST: readonly CtfTask[] = [
	{
		id: "rename-run_checkout-to-execute_checkout",
		category: "rename",
		prompt:
			"Rename the function `run_checkout` in app/src/checkout.rs to `execute_checkout`. " +
			"Update every real call site, including inside `run_checkout_twice` in the same file, " +
			"and its own re-export in app/src/lib.rs. Do not touch any other file.",
		checker: all(
			noCompileErrors(["app/src/checkout.rs", "app/src/lib.rs"]),
			fileContains("app/src/checkout.rs", "execute_checkout"),
			fileLacks("app/src/checkout.rs", "run_checkout("),
		),
	},
	{
		id: "move-run_checkout_twice-to-new-file",
		category: "move",
		prompt:
			"Move the function `run_checkout_twice` out of app/src/checkout.rs into a new module " +
			"app/src/checkout_batch.rs, keeping it public. Update app/src/lib.rs's own `mod`/`pub use` " +
			"declarations so both functions are still re-exported. checkout.rs must no longer define " +
			"run_checkout_twice itself.",
		checker: all(
			noCompileErrors(["app/src/checkout.rs", "app/src/checkout_batch.rs", "app/src/lib.rs"]),
			fileContains("app/src/checkout_batch.rs", "run_checkout_twice"),
			fileLacks("app/src/checkout.rs", "fn run_checkout_twice"),
		),
	},
	{
		id: "extract-Processor-trait-from-StripeProcessor",
		category: "extract-interface",
		prompt:
			"Extract a new trait named `Processor` from `StripeProcessor` in app/src/stripe.rs, " +
			"containing its `process` method signature. Make `StripeProcessor` implement `Processor` " +
			"explicitly, in addition to `PaymentProcessor`.",
		checker: all(
			noCompileErrors(["app/src/stripe.rs"]),
			fileContains("app/src/stripe.rs", "trait Processor", "impl Processor for StripeProcessor"),
		),
	},
];
