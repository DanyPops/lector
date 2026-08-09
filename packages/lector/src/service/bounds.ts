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
