import type { SymbolSearchResult } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "./lector-client.ts";

/**
 * Thin wrapper over workspace.findSymbols. No seedFile parameter here or
 * anywhere above this call: Lector's discoverSeedFile() bounded
 * auto-discovery fully absorbs that tsserver implementation detail, so a
 * pi tool schema (and the model calling it) never needs to know it exists.
 *
 * `directory` is required, not an optional override with a hidden default:
 * exactly like rawRead/exactEdit require an explicit path rather than
 * defaulting to "whatever file was last touched," a symbol query requires
 * an explicit project rather than silently defaulting to the session's own
 * cwd. The caller passes cwd itself to search the current project -- there
 * is no implicit fallback anywhere in this module.
 */
export interface FindSymbolsOperations {
	findSymbols(query: string, directory: string): Promise<SymbolSearchResult>;
}

export function createLectorFindSymbolsOperations(): FindSymbolsOperations {
	return {
		async findSymbols(query, directory) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.findSymbols", { workspaceId, query });
				},
			);
		},
	};
}
