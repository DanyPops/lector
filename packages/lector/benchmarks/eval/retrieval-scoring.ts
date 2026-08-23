/**
 * recall@k/MRR scoring for the hybrid-retrieval benchmark (efe48de0) -- the standard
 * information-retrieval metrics, applied to Lector's own retrieval backends against the
 * hand-verified ground-truth corpus (ground-truth-corpus.ts). Self-tested against hand-computed
 * synthetic cases before ever being pointed at a real Lector search result, matching Alef's own
 * fixture-self-test discipline this repo's eval work has followed throughout.
 */

import type { GroundTruthSymbolReference, GroundTruthTask } from "./ground-truth-corpus.ts";

/** `path#symbolName` -- the identity retrieval results and ground-truth relevant symbols are compared by. */
export function symbolReferenceKey(reference: GroundTruthSymbolReference): string {
	return `${reference.path}#${reference.symbolName}`;
}

export class InvalidRetrievalScoringInput extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidRetrievalScoringInput";
	}
}

function assertNonEmptyRelevant(relevant: readonly string[]): void {
	if (relevant.length === 0) throw new InvalidRetrievalScoringInput("relevant must be non-empty -- an empty ground-truth answer set is a malformed task, not a vacuous pass");
}

function assertPositiveK(k: number): void {
	if (!Number.isSafeInteger(k) || k <= 0) throw new InvalidRetrievalScoringInput(`k must be a positive integer, got ${k}`);
}

/**
 * Fraction of `relevant` items present anywhere in the first `k` entries of `retrieved`.
 * 1.0 means every relevant item was returned within the top k; 0.0 means none were.
 */
export function recallAtK(retrieved: readonly string[], relevant: readonly string[], k: number): number {
	assertNonEmptyRelevant(relevant);
	assertPositiveK(k);
	const topK = new Set(retrieved.slice(0, k));
	const found = relevant.filter((item) => topK.has(item));
	return found.length / relevant.length;
}

/**
 * Reciprocal rank of the first relevant item found in `retrieved` (1-indexed), independent of
 * any k cutoff -- 0 when no relevant item appears anywhere in `retrieved`.
 */
export function meanReciprocalRank(retrieved: readonly string[], relevant: readonly string[]): number {
	assertNonEmptyRelevant(relevant);
	const relevantSet = new Set(relevant);
	for (let index = 0; index < retrieved.length; index++) {
		const item = retrieved[index];
		if (item !== undefined && relevantSet.has(item)) return 1 / (index + 1);
	}
	return 0;
}

export interface RetrievalScore {
	readonly taskId: string;
	readonly method: string;
	readonly recallAtK: number;
	readonly mrr: number;
}

/** Scores one retrieval method's real output against one ground-truth task's hand-verified relevant symbols. */
export function scoreGroundTruthTask(task: GroundTruthTask, method: string, retrieved: readonly string[], k: number): RetrievalScore {
	const relevant = task.relevantSymbols.map(symbolReferenceKey);
	return { taskId: task.id, method, recallAtK: recallAtK(retrieved, relevant, k), mrr: meanReciprocalRank(retrieved, relevant) };
}

/** Distinct file paths a ground-truth task's relevant symbols live in -- the identity every retrieval method compared here can express, even ripgrep, which has no concept of a symbol at all. */
export function taskRelevantPaths(task: GroundTruthTask): string[] {
	return [...new Set(task.relevantSymbols.map((reference) => reference.path))];
}

/** File-level counterpart to scoreGroundTruthTask -- for a method (lexical, annotation) whose real backend cannot express exact symbol identity, only which file it landed in. */
export function scoreGroundTruthTaskByPath(task: GroundTruthTask, method: string, retrievedPaths: readonly string[], k: number): RetrievalScore {
	const relevant = taskRelevantPaths(task);
	return { taskId: task.id, method, recallAtK: recallAtK(retrievedPaths, relevant, k), mrr: meanReciprocalRank(retrievedPaths, relevant) };
}

export class MissingRetrievalResult extends Error {
	constructor(
		readonly taskId: string,
		readonly method: string,
	) {
		super(`no retrieval result recorded for task "${taskId}" under method "${method}" -- every corpus task must be attempted`);
		this.name = "MissingRetrievalResult";
	}
}

/**
 * Scores every ground-truth-corpus entry for one retrieval method, producing one RetrievalScore
 * per task -- the combining function `3cf2e918`'s benchmark runner calls once per method compared.
 */
export function scoreRetrievalResults(
	corpus: readonly GroundTruthTask[],
	method: string,
	retrievedByTaskId: ReadonlyMap<string, readonly string[]>,
	k: number,
): readonly RetrievalScore[] {
	return corpus.map((task) => {
		const retrieved = retrievedByTaskId.get(task.id);
		if (retrieved === undefined) throw new MissingRetrievalResult(task.id, method);
		return scoreGroundTruthTask(task, method, retrieved, k);
	});
}
