import type { ExternalSearchBounds, SourcegraphCodeSearchResult } from "../external-search/external-search-result.ts";

export interface SourcegraphSearchPort {
	searchCode(query: string, bounds: ExternalSearchBounds): Promise<SourcegraphCodeSearchResult>;
}
