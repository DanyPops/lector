import { describe, expect, it } from "bun:test";
import type { GroundTruthTask } from "../../../benchmarks/eval/ground-truth-corpus.ts";
import {
	InvalidRetrievalScoringInput,
	MissingRetrievalResult,
	meanReciprocalRank,
	recallAtK,
	scoreGroundTruthTask,
	scoreRetrievalResults,
	symbolReferenceKey,
} from "../../../benchmarks/eval/retrieval-scoring.ts";

describe("recallAtK", () => {
	it("scores a perfect match (every relevant item present in the top k) as 1.0", () => {
		expect(recallAtK(["a", "b", "c"], ["a", "b", "c"], 3)).toBe(1.0);
	});

	it("scores a partial match (one of two relevant items found) as 0.5", () => {
		expect(recallAtK(["x", "a", "y"], ["a", "b"], 3)).toBe(0.5);
	});

	it("scores zero overlap as 0.0", () => {
		expect(recallAtK(["x", "y", "z"], ["a"], 3)).toBe(0.0);
	});

	it("scores a relevant item at rank 3 of 5 as recall@5 = 1.0 (the standard worked example)", () => {
		expect(recallAtK(["x", "y", "a", "z", "w"], ["a"], 5)).toBe(1.0);
	});

	it("scores the same relevant item as recall@2 = 0 once its rank falls beyond k", () => {
		expect(recallAtK(["x", "y", "a", "z", "w"], ["a"], 2)).toBe(0.0);
	});

	it("rejects an empty relevant set as a malformed task, not a vacuous 1.0", () => {
		expect(() => recallAtK(["a"], [], 3)).toThrow(InvalidRetrievalScoringInput);
	});

	it("rejects a zero or negative k", () => {
		expect(() => recallAtK(["a"], ["a"], 0)).toThrow(InvalidRetrievalScoringInput);
		expect(() => recallAtK(["a"], ["a"], -1)).toThrow(InvalidRetrievalScoringInput);
	});
});

describe("meanReciprocalRank", () => {
	it("scores the first relevant item at rank 1 as MRR = 1.0", () => {
		expect(meanReciprocalRank(["a", "x", "y"], ["a"])).toBe(1.0);
	});

	it("scores a relevant item at rank 3 of 5 as MRR = 1/3 (the standard worked example)", () => {
		expect(meanReciprocalRank(["x", "y", "a", "z", "w"], ["a"])).toBeCloseTo(1 / 3, 10);
	});

	it("is independent of any k cutoff -- the same rank-3 item still scores 1/3 regardless of how few results a caller later slices to", () => {
		const retrieved = ["x", "y", "a", "z", "w"];
		expect(meanReciprocalRank(retrieved, ["a"])).toBeCloseTo(1 / 3, 10);
		expect(meanReciprocalRank(retrieved.slice(0, 2), ["a"])).toBe(0); // "a" isn't even present in this shorter slice
	});

	it("scores zero overlap as MRR = 0", () => {
		expect(meanReciprocalRank(["x", "y", "z"], ["a"])).toBe(0);
	});

	it("uses the first-ranked relevant item when several relevant items are present", () => {
		expect(meanReciprocalRank(["x", "b", "a"], ["a", "b"])).toBeCloseTo(1 / 2, 10);
	});

	it("rejects an empty relevant set as a malformed task", () => {
		expect(() => meanReciprocalRank(["a"], [])).toThrow(InvalidRetrievalScoringInput);
	});
});

describe("symbolReferenceKey", () => {
	it("formats a path/symbolName pair as a single comparable string", () => {
		expect(symbolReferenceKey({ path: "packages/app/src/checkout.ts", symbolName: "runCheckout" })).toBe("packages/app/src/checkout.ts#runCheckout");
	});
});

const SYNTHETIC_TASK: GroundTruthTask = {
	id: "synthetic-task",
	category: "symbol-name",
	task: "synthetic",
	relevantSymbols: [{ path: "a.ts", symbolName: "foo" }],
};

describe("scoreGroundTruthTask", () => {
	it("scores a real retrieval result against one ground-truth task's relevant symbols", () => {
		const score = scoreGroundTruthTask(SYNTHETIC_TASK, "lexical", ["a.ts#foo"], 5);
		expect(score).toEqual({ taskId: "synthetic-task", method: "lexical", recallAtK: 1.0, mrr: 1.0 });
	});

	it("scores a miss as recall 0 and MRR 0", () => {
		const score = scoreGroundTruthTask(SYNTHETIC_TASK, "lexical", ["b.ts#bar"], 5);
		expect(score).toEqual({ taskId: "synthetic-task", method: "lexical", recallAtK: 0, mrr: 0 });
	});
});

describe("scoreRetrievalResults", () => {
	const corpus: readonly GroundTruthTask[] = [
		SYNTHETIC_TASK,
		{ id: "synthetic-task-2", category: "lexical", task: "synthetic 2", relevantSymbols: [{ path: "b.ts", symbolName: "bar" }] },
	];

	it("produces one RetrievalScore per corpus entry for the given method", () => {
		const results = scoreRetrievalResults(
			corpus,
			"symbol",
			new Map([
				["synthetic-task", ["a.ts#foo"]],
				["synthetic-task-2", ["x.ts#nope"]],
			]),
			5,
		);
		expect(results).toEqual([
			{ taskId: "synthetic-task", method: "symbol", recallAtK: 1.0, mrr: 1.0 },
			{ taskId: "synthetic-task-2", method: "symbol", recallAtK: 0, mrr: 0 },
		]);
	});

	it("fails fast when a corpus task has no recorded retrieval result, rather than silently skipping it", () => {
		expect(() => scoreRetrievalResults(corpus, "symbol", new Map([["synthetic-task", ["a.ts#foo"]]]), 5)).toThrow(MissingRetrievalResult);
	});
});
