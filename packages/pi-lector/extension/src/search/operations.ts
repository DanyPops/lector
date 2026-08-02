import type { TextSearchResult } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "../lector-client.ts";

/**
 * Thin wrapper over workspace.searchText. `directory` is required, same convention as
 * find_symbols/git operations -- no implicit "whatever the session's cwd is" fallback.
 */
export interface SearchOperations {
	search(query: string, directory: string, maxMatches: number, maxBytes: number): Promise<TextSearchResult>;
}

export function createLectorSearchOperations(): SearchOperations {
	return {
		async search(query, directory, maxMatches, maxBytes) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.searchText", { workspaceId, query, maxMatches, maxBytes });
				},
			);
		},
	};
}
