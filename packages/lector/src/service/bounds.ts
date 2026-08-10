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
