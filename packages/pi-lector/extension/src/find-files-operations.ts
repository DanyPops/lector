import type { FindFilesResult } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "./lector-client.ts";

/**
 * Thin wrapper over workspace.findFiles -- the `find`-shaped half of the classic grep+find pair,
 * distinct from search_code (content). `directory` is required, same convention as
 * find_symbols/search_code -- no implicit "whatever the session's cwd is" fallback.
 */
export interface FindFilesOperations {
	findFiles(patterns: readonly string[], directory: string, maxResults: number, maxBytes: number): Promise<FindFilesResult>;
}

export function createLectorFindFilesOperations(): FindFilesOperations {
	return {
		async findFiles(patterns, directory, maxResults, maxBytes) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.findFiles", { workspaceId, patterns, maxResults, maxBytes });
				},
			);
		},
	};
}
