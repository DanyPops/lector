import type { WorkspaceSymbol } from "@danypops/lector";
import { lectorClient, workspaceForDirectory } from "./lector-client.ts";

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
	findSymbols(query: string, directory: string): Promise<readonly WorkspaceSymbol[]>;
}

export function createLectorFindSymbolsOperations(): FindSymbolsOperations {
	return {
		async findSymbols(query, directory) {
			const client = await lectorClient();
			const { workspaceId } = await workspaceForDirectory(directory);
			const { symbols } = await client.call("workspace.findSymbols", { workspaceId, query });
			return symbols;
		},
	};
}
