/**
 * How long search.symbols/search.text wait for one workspace's own query before reporting it as
 * "loading" and moving on -- generous enough for typical cold-start (TypeScript/Python/Go/C++/
 * Bash/YAML all settle well under 3s; only rust-analyzer's own measured ~2.5s worst case comes
 * close), bounded so one slow workspace can't stall every other workspace's real results.
 */
export const MAX_INITIAL_JOB_WAIT_MS = 30_000;
export const MAX_SYMBOL_RESULTS = 5_000;
/**
 * findSymbols asks the backend for more than the caller wants, then filters to the real
 * find_symbols contract (case-insensitive substring name match, workspace-root scope,
 * deduplication) before truncating to the caller's own maxResults. Without overfetching, a
 * backend's own irrelevant fuzzy/out-of-root hits could crowd out true matches within its raw
 * cutoff, producing false negatives purely from truncation order.
 */
export const SYMBOL_SEARCH_OVERFETCH_MULTIPLIER = 5;
export const MAX_SOURCE_MANIFEST_BYTES = 50 * 1024 * 1024;
/** Files populateSymbolGraph dispatches to the LSP concurrently -- cost is round-trip latency, not CPU (see populate-symbol-graph-concurrency.perf.test.ts). Well under LspSymbolIndex's default 256 open-file cap. */
export const POPULATION_CONCURRENCY = 8;
/**
 * Bound for the allNodes/allEdges reads used to find files referencing a changed file's
 * declarations, when deciding what a repopulate can safely skip. If the graph is at or beyond
 * this size, the read may be truncated and could miss a real dependent -- fails closed by
 * reprocessing every file instead, never by risking a silently dropped cross-file edge.
 */
export const MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP = 200_000;

/**
 * dispatch()'s own choke-point instrumentation: an operation whose end-to-end duration meets or
 * exceeds this is logged at warn even though it succeeded -- the same
 * SLOW_REQUEST_WARN_THRESHOLD_MS pattern LanguageServerProcess already uses for individual LSP
 * round trips, applied one layer up, to every operation (not just LSP ones) regardless of
 * whether it happens to be VehicleRegistry-migrated. Deliberately more generous than a single
 * interactive LSP request's own 3s threshold: a legitimate batch operation (populateSymbolGraph
 * over a large workspace) can honestly take longer than any single request should, so this
 * threshold exists to catch an INTERACTIVE operation quietly regressing toward batch-shaped
 * latency, not to flag every long-running background job as a problem.
 */
export const DISPATCH_SLOW_WARN_THRESHOLD_MS = 5_000;

/**
 * Shared defaults/ceilings for every code-intelligence operation whose result is a list a real
 * workspace can make arbitrarily large -- goToDefinition/goToImplementation/findReferences/
 * incomingCalls/outgoingCalls all return WorkspaceLocation-shaped entries of comparable size.
 * Live evidence: an unbounded call-hierarchy query against a real project returned dozens of
 * framework/stdlib entries with no way for a caller to ask for fewer.
 */
export const DEFAULT_LOCATION_RESULTS = 200;
export const MAX_LOCATION_RESULTS = 2_000;
export const DEFAULT_LOCATION_BYTES = 256 * 1024;
export const MAX_LOCATION_BYTES = 2 * 1024 * 1024;

/** documentSymbols can legitimately enumerate thousands of entries for one large generated/vendored file -- a higher ceiling than the location-shaped operations above, which are usually a handful of cross-file hits. */
export const DEFAULT_DOCUMENT_SYMBOL_RESULTS = 2_000;
export const MAX_DOCUMENT_SYMBOL_RESULTS = 20_000;
export const DEFAULT_DOCUMENT_SYMBOL_BYTES = 1024 * 1024;
export const MAX_DOCUMENT_SYMBOL_BYTES = 8 * 1024 * 1024;

export const DEFAULT_DIAGNOSTIC_RESULTS = 500;
export const MAX_DIAGNOSTIC_RESULTS = 5_000;
export const DEFAULT_DIAGNOSTIC_BYTES = 256 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

/** hover text is one string, not a list -- bounded by bytes only, via truncateUtf8. */
export const DEFAULT_HOVER_BYTES = 16 * 1024;
export const MAX_HOVER_BYTES = 256 * 1024;

/**
 * workspace.mutationHistory returns real stored file snapshots, not location-shaped metadata --
 * one entry's own beforeContent is capped independently (MAX_MUTATION_HISTORY_ENTRY_CONTENT_BYTES)
 * so a single giant file's history can't exhaust the whole response budget by itself, then the
 * resulting list is bounded by count and total bytes same as every other list operation.
 */
export const DEFAULT_MUTATION_HISTORY_RESULTS = 100;
export const MAX_MUTATION_HISTORY_RESULTS = 2_000;
export const DEFAULT_MUTATION_HISTORY_BYTES = 512 * 1024;
export const MAX_MUTATION_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_MUTATION_HISTORY_ENTRY_CONTENT_BYTES = 64 * 1024;

/** workspace.reachableFrom/symbolEdgesFrom/symbolEdgesTo already bound traversal depth (maxDepth/kind) -- this bounds the resulting symbol list's own size, which depth alone does not cap in a densely-connected graph. */
export const DEFAULT_GRAPH_QUERY_RESULTS = 500;
export const MAX_GRAPH_QUERY_RESULTS = 5_000;
export const DEFAULT_GRAPH_QUERY_BYTES = 512 * 1024;
export const MAX_GRAPH_QUERY_BYTES = 4 * 1024 * 1024;

/** Validates an optional caller-supplied bound against its own ceiling, defaulting when omitted -- the one place every bounded code-intelligence operation resolves "how many/how much" so the same invalid-input contract (TypeError, not a silent clamp) applies everywhere. */
export function resolveBound(explicit: number | undefined, defaultValue: number, max: number, name: string): number {
	const value = explicit ?? defaultValue;
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} must be a positive safe integer no greater than ${max}`);
	return value;
}

/**
 * How long workspace.populateSymbolGraph's own optional retry-on-race loop may keep retrying a
 * WorkspaceChangedDuringPopulation failure before giving up and rethrowing it -- zero/omitted (the
 * default, via resolveRetryBudgetMs) preserves today's exact fail-fast behavior; this is opt-in.
 */
export const MAX_POPULATE_RETRY_BUDGET_MS = 5 * 60_000;
/**
 * Fixed settle delay between retry attempts -- long enough for a burst of related file changes
 * (e.g. one reference-based rename touching several files) to fully land before the next attempt
 * re-derives its own source manifest, short enough not to waste a caller's own bounded budget
 * purely on waiting.
 */
export const POPULATE_RETRY_SETTLE_MS = 500;

/**
 * Validates an optional non-negative retry budget -- distinct from resolveBound's "positive,
 * defaulted" contract because 0/omitted is itself a meaningful, valid value here (retrying is
 * opt-in; 0 means "never retry", not "use some positive default").
 */
export function resolveRetryBudgetMs(explicit: number | undefined, max: number): number {
	if (explicit === undefined) return 0;
	if (!Number.isSafeInteger(explicit) || explicit < 0 || explicit > max) {
		throw new TypeError(`retryTimeBudgetMs must be a non-negative safe integer no greater than ${max}`);
	}
	return explicit;
}
