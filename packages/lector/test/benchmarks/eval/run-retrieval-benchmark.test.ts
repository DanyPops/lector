/**
 * The hybrid-retrieval benchmark run end-to-end against the real ground-truth corpus, real
 * ripgrep, a real typescript-language-server-backed LspSymbolIndex, a real populated
 * InMemorySymbolGraph, and a real InMemorySymbolAnnotations store seeded with hand-authored
 * annotations -- no LLM, no mocking of any retrieval backend. Every assertion below reproduces a
 * real number this benchmark measured live (see the decision doc for the full report), not a
 * value chosen in advance -- this test protects those measurements against regression.
 */

import { describe, expect, it } from "bun:test";
import { runRetrievalBenchmark } from "../../../benchmarks/eval/run-retrieval-benchmark.ts";

describe("runRetrievalBenchmark", () => {
	it("produces one TaskReport per ground-truth-corpus entry, each covering every compared method", async () => {
		const report = await runRetrievalBenchmark({ k: 5, maxGraphDepth: 2 });
		expect(report.tasks).toHaveLength(6);
		for (const task of report.tasks) {
			expect(Object.keys(task.methods).sort()).toEqual(["annotation", "combined", "graph", "lexical", "symbol"]);
		}
	}, 60_000);

	it("scores lexical search as a full pass on its own literal-string category, but a total failure on the semantic-gap category", async () => {
		const report = await runRetrievalBenchmark({ k: 5, maxGraphDepth: 2 });
		expect(report.aggregateByCategoryAndMethod.lexical?.lexical).toBe(1);
		expect(report.aggregateByCategoryAndMethod["semantic-gap"]?.lexical).toBe(0);
	}, 60_000);

	it("scores agent-authored annotation search as a perfect 1.0 across every semantic-gap task, strictly ahead of lexical/symbol/graph alone", async () => {
		const report = await runRetrievalBenchmark({ k: 5, maxGraphDepth: 2 });
		const semanticGap = report.aggregateByCategoryAndMethod["semantic-gap"];
		expect(semanticGap?.annotation).toBe(1);
		expect(semanticGap?.lexical).toBeLessThan(1);
		expect(semanticGap?.symbol).toBeLessThan(1);
		expect(semanticGap?.graph).toBeLessThan(1);
	}, 60_000);

	it("recovers the correct answer via annotation search on the one semantic-gap task where a naive keyword guess resolves symbol/graph search to the wrong class entirely", async () => {
		const report = await runRetrievalBenchmark({ k: 5, maxGraphDepth: 2 });
		const gatewayTask = report.tasks.find((task) => task.taskId === "semantic-gap-payment-gateway");
		expect(gatewayTask?.methods.symbol?.fileRecallAtK).toBe(0); // "Gateway" fuzzy-matches the unrelated LegacyGateway
		expect(gatewayTask?.methods.graph?.fileRecallAtK).toBe(0); // graph traversal from that same wrong seed can't recover
		expect(gatewayTask?.methods.lexical?.fileRecallAtK).toBe(0); // ripgrep for "gateway" matches only the unrelated legacy files
		expect(gatewayTask?.methods.annotation?.fileRecallAtK).toBe(1); // the hand-authored annotation bridges the vocabulary gap
	}, 60_000);

	it("shows naive concatenation-based 'combined' retrieval can underperform its own best single method when a noisy method is unioned in first, unbounded by k", async () => {
		const report = await runRetrievalBenchmark({ k: 5, maxGraphDepth: 2 });
		const contractTask = report.tasks.find((task) => task.taskId === "semantic-gap-processor-contract");
		// symbol/annotation alone both find the right file; naive concatenation (lexical's own 5
		// wrong matches first, unsliced before the union) pushes the correct file past the top-k cutoff.
		expect(contractTask?.methods.symbol?.fileRecallAtK).toBe(1);
		expect(contractTask?.methods.annotation?.fileRecallAtK).toBe(1);
		expect(contractTask?.methods.combined?.fileRecallAtK).toBe(0);
	}, 60_000);

	it("computes symbol-level recall via findWorkspaceSymbols' own fuzzy prefix matching -- a plain 'runCheckout' query also recovers the caller runCheckoutTwice by name coincidence", async () => {
		const report = await runRetrievalBenchmark({ k: 5, maxGraphDepth: 2 });
		const crossFileTask = report.tasks.find((task) => task.taskId === "cross-file-runcheckout-caller");
		expect(crossFileTask?.methods.symbol?.symbolRecallAtK).toBe(1);
		expect(crossFileTask?.methods.graph?.symbolRecallAtK).toBe(1);
	}, 60_000);
});
