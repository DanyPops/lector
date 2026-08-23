/**
 * Hand-verified ground-truth retrieval tasks against `test/fixtures/typescript-reference` --
 * the retrieval-quality corpus the hybrid-search benchmark (efe48de0) scores recall/MRR against.
 *
 * Every `relevantSymbols` entry here is cross-checked against facts this fixture's own
 * conformance suite already asserts (see
 * `test/code-intelligence/typescript-reference-conformance.test.ts` and `fixture.json`'s own
 * `expectedSymbols`) and independently re-verified in
 * `test/benchmarks/eval/ground-truth-corpus.test.ts` via a real `TreeSitterSymbolIndex.findSymbols`
 * call against the materialized fixture -- never asserted by hand alone, matching Alef's own
 * fixture-self-test discipline this repo's eval work has followed throughout.
 *
 * A plain `const` declaration (e.g. `rawTextMarker` in raw-text.ts) is NOT indexed by
 * TreeSitterSymbolIndex today (confirmed empirically while building this corpus) -- every entry
 * below deliberately targets a function/class/interface, the kinds this backend does resolve.
 */

export interface GroundTruthSymbolReference {
	readonly path: string;
	readonly symbolName: string;
}

export interface GroundTruthTask {
	readonly id: string;
	/** What kind of retrieval strategy this task is meant to stress -- informs the final benchmark's per-category breakdown. */
	readonly category: "lexical" | "symbol-name" | "cross-file-reference" | "semantic-gap";
	readonly task: string;
	readonly relevantSymbols: readonly GroundTruthSymbolReference[];
}

export const GROUND_TRUTH_CORPUS: readonly GroundTruthTask[] = [
	{
		id: "lexical-stripe-transaction-id-literal",
		category: "lexical",
		task: 'Which class builds a transaction id string as `stripe:${order.id}:${order.amountCents}`?',
		relevantSymbols: [{ path: "packages/app/src/stripe.ts", symbolName: "StripeProcessor" }],
	},
	{
		id: "symbol-name-runcheckout-definition",
		category: "symbol-name",
		task: "Where is runCheckout defined?",
		relevantSymbols: [{ path: "packages/app/src/checkout.ts", symbolName: "runCheckout" }],
	},
	{
		id: "cross-file-runcheckout-caller",
		category: "cross-file-reference",
		task: "What function calls runCheckout, and where is that function itself defined?",
		relevantSymbols: [
			{ path: "packages/app/src/checkout.ts", symbolName: "runCheckoutTwice" },
			{ path: "packages/app/src/checkout.ts", symbolName: "runCheckout" },
		],
	},
	{
		id: "semantic-gap-payment-gateway",
		category: "semantic-gap",
		task: "What handles turning an order into a receipt through a third-party payment gateway?",
		relevantSymbols: [{ path: "packages/app/src/stripe.ts", symbolName: "StripeProcessor" }],
	},
	{
		id: "semantic-gap-processor-contract",
		category: "semantic-gap",
		task: "What contract must every concrete payment handler implementation satisfy?",
		relevantSymbols: [{ path: "packages/contracts/src/payment.ts", symbolName: "PaymentProcessor" }],
	},
	{
		id: "semantic-gap-overloaded-order-description",
		category: "semantic-gap",
		task: "Find the function overloaded to accept either a full order object or just a plain order id string.",
		relevantSymbols: [{ path: "packages/contracts/src/payment.ts", symbolName: "describeOrder" }],
	},
] as const;
