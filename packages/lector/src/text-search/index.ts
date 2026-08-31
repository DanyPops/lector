export { assertSafeGlobPattern, UnsafeGlobPattern } from "./assert-safe-glob-pattern.ts";
export { assertSafeSearchQuery, UnsafeSearchQuery } from "./assert-safe-search-query.ts";
export { FffIndexedTextEngineFactory, type FffIndexedTextEngineOptions } from "./fff-indexed-text-engine.ts";
export { findFiles } from "./find-files.ts";
export type { FindFilesResult } from "./find-files-result.ts";
export {
	IndexedSearchQueryBypass,
	type IndexedTextEngine,
	type IndexedTextEngineFactory,
	IndexedTextSearch,
	type IndexedTextSearchOptions,
	type IndexedTextStatus,
} from "./indexed-text-search.ts";
export type { FindFilesOptions, TextSearchOptions, TextSearchPort, TextSearchWorkspaceOrigin } from "./port.ts";
export { RipgrepTextSearch } from "./ripgrep-text-search.ts";
export { searchText } from "./search-text.ts";
export type { LexicalSearchProvenance, TextSearchMatch, TextSearchResult } from "./text-search-result.ts";
