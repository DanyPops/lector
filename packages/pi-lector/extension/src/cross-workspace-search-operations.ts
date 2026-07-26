import type { SymbolSearchResult, TextSearchResult, WorkspaceQueryOutcome } from "@danypops/lector";
import { lectorClient, workspaceForDirectory } from "./lector-client.ts";

/**
 * Fans out across explicitly-named directories only -- never the daemon's own "every registered
 * workspace" default. Lector's daemon is a shared, system-wide service: leaving workspaceIds
 * unset would search every project any other concurrent Pi session has ever registered against
 * it, not just this session's own (confirmed live, not assumed -- a real fetched jittor workspace
 * from an unrelated session showed up in an early test of this exact feature). `directories` is
 * required, same "no implicit fallback" convention as find_symbols/search_code.
 */
export interface CrossWorkspaceSearchOperations {
	findSymbols(query: string, directories: readonly string[], timeoutMs?: number): Promise<readonly WorkspaceQueryOutcome<SymbolSearchResult>[]>;
	searchText(
		query: string,
		directories: readonly string[],
		maxMatches: number,
		maxBytes: number,
		timeoutMs?: number,
	): Promise<readonly WorkspaceQueryOutcome<TextSearchResult>[]>;
}

async function resolveWorkspaceIds(directories: readonly string[]): Promise<readonly string[]> {
	const resolved = await Promise.all(directories.map((directory) => workspaceForDirectory(directory)));
	return resolved.map((r) => r.workspaceId);
}

export function createLectorCrossWorkspaceSearchOperations(): CrossWorkspaceSearchOperations {
	return {
		async findSymbols(query, directories, timeoutMs) {
			const workspaceIds = await resolveWorkspaceIds(directories);
			const client = await lectorClient();
			const { results } = await client.call("search.symbols", { query, workspaceIds, timeoutMs });
			return results;
		},
		async searchText(query, directories, maxMatches, maxBytes, timeoutMs) {
			const workspaceIds = await resolveWorkspaceIds(directories);
			const client = await lectorClient();
			const { results } = await client.call("search.text", { query, maxMatches, maxBytes, workspaceIds, timeoutMs });
			return results;
		},
	};
}
