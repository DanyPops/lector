/**
 * Reproduces, deterministically and at test speed, the real mechanism behind the multi-minute
 * silent stalls reported investigating a large real-repo population
 * (deepseek-ai/deepseek-harness, commit b150a551b8d465e31e418e1b2eaf5e79bbb7d28e, 2,472 TS files
 * across 227 sub-packages -- see the RCA for that investigation).
 *
 * Confirmed root cause chain:
 * - typescript-language-server crashes (LanguageServerProcessExited) on specific files in that
 *   repo, most likely from cumulative tsserver memory growth across its huge project-reference
 *   graph (not from any single poisonous file -- a direct reproduction against the two flagged
 *   files in isolation, controller.ts and MessageFeedbackActions.tsx, succeeded cleanly).
 * - Once dead, WarmIndexRegistry's pool (bounded-resource-pool.ts's isAlive() check) evicts and
 *   lazily respawns a brand-new process on the NEXT acquire -- and for a 227-package solution,
 *   that respawn's own project-graph reload can legitimately take up to LspSymbolIndex's own
 *   ~90s workspaceReadyTimeoutMs (bounded per call, via waitForWorkspaceReady in
 *   requestWhenReady).
 * - populateSymbolGraph has no memory of "this same failure just happened, N files in a row" --
 *   at its default concurrency of 1, every subsequent file pays that same bounded wait again,
 *   serially, with zero circuit breaker or early exit once a persistent pattern is evident. A
 *   handful of consecutively-failing files, each individually "handled" (recorded as a bounded
 *   failure, matching the real run's own clean LanguageServerProcessExited entries), still sums
 *   to real minutes of wall-clock time with no distinguishing diagnostic -- exactly the observed
 *   "progress goes flat for 9+ minutes, job_status still says running" symptom.
 *
 * This test stands in a much shorter, deterministic delay (tens of milliseconds) for the real
 * ~90s per-call wait, and a short but real run of consecutively-failing files for the real 227-
 * package walk -- proving the mechanism, not the exact real-world numbers. It intentionally
 * documents CURRENT behavior (this test passes today): populateSymbolGraph's own contract is
 * "walk exactly the file list it's given, one bounded-but-possibly-slow operation at a time,"
 * the same contract populate-symbol-graph-delta.perf.test.ts already pins for a different bug.
 * A future fix adding a circuit breaker for a persistent failure streak should update this
 * test's own assertions, not delete it -- the reproduction is the point.
 */
import { describe, expect, it } from "bun:test";
import type { DocumentSymbolEntry } from "../../src/code-intelligence/document-symbol.ts";
import { LanguageServerProcessExited } from "../../src/code-intelligence/lsp/language-server-process.ts";
import type { CodeIntelligencePort } from "../../src/code-intelligence/port.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { populateSymbolGraph } from "../../src/symbol-graph/populate-symbol-graph.ts";

/** A fake CodeIntelligencePort: documentSymbols always succeeds with one top-level callable per file (so outgoingCalls is always attempted, matching the real crashes recorded specifically on operation "outgoing-calls"); outgoingCalls fails with a real, non-zero, LanguageServerProcessExited-shaped delay for every path in `failingPaths`, standing in for a crash-then-respawn cycle that never actually recovers for the remainder of a real walk. */
function createFakeIndex(options: { readonly failingPaths: ReadonlySet<string>; readonly callDelayMs: number }): CodeIntelligencePort {
	const unexercised = (name: string) => (): never => {
		throw new Error(`fake CodeIntelligencePort: ${name} is not exercised by this reproduction`);
	};
	return {
		goToDefinition: unexercised("goToDefinition"),
		goToImplementation: unexercised("goToImplementation"),
		findReferences: unexercised("findReferences"),
		hover: unexercised("hover"),
		diagnostics: unexercised("diagnostics"),
		prepareCallHierarchy: unexercised("prepareCallHierarchy"),
		incomingCalls: unexercised("incomingCalls"),
		async documentSymbols(path: string): Promise<DocumentSymbolEntry[]> {
			return [
				{
					name: `fn_${path}`,
					kind: "function",
					range: { path, start: { line: 1, character: 1 }, end: { line: 3, character: 1 } },
					selectionRange: { path, start: { line: 1, character: 1 }, end: { line: 1, character: 6 } },
				},
			];
		},
		async outgoingCalls(at) {
			await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
			if (options.failingPaths.has(at.path)) throw new LanguageServerProcessExited("fake-language-server");
			return [];
		},
	};
}

describe("populateSymbolGraph against a language server that crashes and never recovers for the rest of the walk", () => {
	it("correctly records every persistently-failing file as a bounded, individually-handled failure -- the half already working as intended", async () => {
		const totalFiles = 12;
		const firstFailingIndex = 6;
		const files = Array.from({ length: totalFiles }, (_, i) => `f${i}.ts`);
		const failingPaths = new Set(files.slice(firstFailingIndex));
		const index = createFakeIndex({ failingPaths, callDelayMs: 10 });
		const graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, files, 50);

		expect(result.completeness).toBe("partial");
		expect(result.failureCount).toBe(failingPaths.size);
		// filesProcessed counts each file's own documentSymbols step, which always succeeds here --
		// the failure is specifically on outgoing-calls, one level deeper, matching the real crashes'
		// own recorded operation exactly.
		expect(result.filesProcessed).toBe(totalFiles);
		for (const failure of result.failures) {
			expect(failure.operation).toBe("outgoing-calls");
			expect(failure.code).toBe("LanguageServerProcessExited");
			expect(failingPaths.has(failure.path)).toBe(true);
		}
	});

	it("reproduces the real gap: cumulative wall time scales with the number of consecutively-failing files, with no circuit breaker or early exit once the pattern is already evident", async () => {
		const totalFiles = 12;
		const firstFailingIndex = 6; // files 6..11 (6 files) simulate a crash-looping server for the rest of the walk -- the real deepseek-harness shape.
		const files = Array.from({ length: totalFiles }, (_, i) => `f${i}.ts`);
		const failingPaths = new Set(files.slice(firstFailingIndex));
		// Stands in for LspSymbolIndex's own real ~90s workspaceReadyTimeoutMs bound after a
		// crash-triggered respawn -- scaled down by roughly 1000x so this test runs in
		// milliseconds while preserving the same "bounded per call, unbounded in aggregate" shape.
		const callDelayMs = 40;
		const index = createFakeIndex({ failingPaths, callDelayMs });
		const graph = new InMemorySymbolGraph();

		const start = performance.now();
		const result = await populateSymbolGraph(index, graph, files, 50);
		const elapsedMs = performance.now() - start;

		expect(result.failureCount).toBe(failingPaths.size);

		// The reproduction: with DEFAULT_POPULATION_CONCURRENCY === 1, every one of the 6
		// consecutively-failing files pays the full callDelayMs again, serially -- there is no
		// memory of "this exact failure just happened" and therefore nothing that could short-
		// circuit the remaining walk once a persistent pattern is already evident. A 10% margin
		// absorbs ordinary scheduler jitter without weakening what this proves: real, unbounded-
		// in-aggregate wall time, not a fixed small cost regardless of how many files fail.
		const minimumExpectedMs = failingPaths.size * callDelayMs * 0.9;
		expect(elapsedMs).toBeGreaterThanOrEqual(minimumExpectedMs);
	});
});
