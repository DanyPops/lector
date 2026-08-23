/**
 * Hand-authored, per-ground-truth-task queries for the hybrid-retrieval benchmark
 * (efe48de0/3cf2e918) -- one query per real retrieval method, each derived only from words a real
 * agent could plausibly draw from the task's own prompt text, never from already knowing the
 * hand-verified answer. Kept separate from ground-truth-corpus.ts (already gate-verified,
 * task c336c605) rather than extending its own shape, so that task's own completed scope stays
 * untouched.
 *
 * seedAnnotations simulates what a prior agent session would have left behind after genuinely
 * exploring this code -- Lector's own already-decided "agent-authored narrative over raw
 * embeddings" semantic-layer design (see the canceled embedding-search task's reframing).
 * Deliberately worded with different vocabulary than the task prompts themselves, the way a real
 * annotation would be -- this is the one channel meant to bridge the semantic-gap category's own
 * vocabulary mismatch, not restate the prompt.
 */

export interface RetrievalBenchmarkQuery {
	readonly taskId: string;
	readonly lexicalQuery: string;
	readonly symbolQuery: string;
	readonly graphSeedQuery: string;
	readonly annotationQuery: string;
}

export const RETRIEVAL_BENCHMARK_QUERIES: readonly RetrievalBenchmarkQuery[] = [
	{
		// Ripgrep treats the query as a real regex (search_code's own production behavior); "stripe:"
		// is the regex-safe literal prefix a real agent would type rather than the full templated
		// expression from the prompt (which contains $/{/} regex metacharacters).
		taskId: "lexical-stripe-transaction-id-literal",
		lexicalQuery: "stripe:",
		symbolQuery: "Stripe",
		graphSeedQuery: "Stripe",
		annotationQuery: "stripe",
	},
	{
		taskId: "symbol-name-runcheckout-definition",
		lexicalQuery: "runCheckout",
		symbolQuery: "runCheckout",
		graphSeedQuery: "runCheckout",
		annotationQuery: "runCheckout",
	},
	{
		taskId: "cross-file-runcheckout-caller",
		lexicalQuery: "runCheckout",
		symbolQuery: "runCheckout",
		graphSeedQuery: "runCheckout",
		annotationQuery: "runCheckout",
	},
	{
		// "third-party payment gateway" -- a naive keyword guess lands on the wrong file
		// (packages/legacy/src/gateway.cjs's LegacyGateway), never the real answer (StripeProcessor).
		taskId: "semantic-gap-payment-gateway",
		lexicalQuery: "gateway",
		symbolQuery: "Gateway",
		graphSeedQuery: "Gateway",
		annotationQuery: "gateway",
	},
	{
		// "payment handler ... contract" -- "contract" only appears as a substring of the
		// @fixture/contracts import specifier, in files that import it (never in payment.ts itself,
		// which declares the interface but imports nothing). "Payment" is directly reworded from
		// the prompt's own "payment handler" and fairly resolves to PaymentProcessor via fuzzy match.
		taskId: "semantic-gap-processor-contract",
		lexicalQuery: "contract",
		symbolQuery: "Payment",
		graphSeedQuery: "Payment",
		annotationQuery: "contract",
	},
	{
		// "overloaded" appears nowhere in fixture content; "order" is repeated twice in the prompt.
		taskId: "semantic-gap-overloaded-order-description",
		lexicalQuery: "overloaded",
		symbolQuery: "order",
		graphSeedQuery: "order",
		annotationQuery: "overload",
	},
];

export interface SeedAnnotationSpec {
	/** Fixture-root-relative path. */
	readonly path: string;
	/** Text findPositionOf locates within that file to derive the anchor's real declaration position. */
	readonly symbolNeedle: string;
	readonly title: string;
	readonly body: string;
}

export const SEED_ANNOTATIONS: readonly SeedAnnotationSpec[] = [
	{
		path: "packages/app/src/stripe.ts",
		symbolNeedle: "export class StripeProcessor",
		title: "Stripe payment gateway integration",
		body: "Turns an order into a receipt by calling out to Stripe, our third-party payment gateway. Implements the PaymentProcessor contract.",
	},
	{
		path: "packages/contracts/src/payment.ts",
		symbolNeedle: "export interface PaymentProcessor",
		title: "Payment handler contract",
		body: "The contract every concrete payment handler (e.g. StripeProcessor) must implement: given an order, produce a receipt.",
	},
	{
		path: "packages/contracts/src/payment.ts",
		symbolNeedle: "export function describeOrder(value",
		title: "Overloaded order description helper",
		body: "Overloaded to accept either a full order object or a plain order id string, returning a human-readable description either way.",
	},
];
