import type { ExternalSearchBounds, SourcegraphCodeCandidate } from "../domain/external-search-result.ts";

export interface SourcegraphSearchPort {
	searchCode(query: string, bounds: ExternalSearchBounds): Promise<readonly SourcegraphCodeCandidate[]>;
}
