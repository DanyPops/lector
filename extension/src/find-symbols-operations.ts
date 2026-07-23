import type { WorkspaceSymbol } from "@danypops/lector";
import { lectorClient, workspaceIdForCwd } from "./lector-client.ts";

/**
 * Thin wrapper over workspace.findSymbols. No seedFile parameter here or
 * anywhere above this call: Lector's discoverSeedFile() bounded
 * auto-discovery fully absorbs that tsserver implementation detail, so a
 * pi tool schema (and the model calling it) never needs to know it exists.
 */
export interface FindSymbolsOperations {
	findSymbols(query: string): Promise<readonly WorkspaceSymbol[]>;
}

export function createLectorFindSymbolsOperations(cwd: string): FindSymbolsOperations {
	return {
		async findSymbols(query) {
			const client = await lectorClient();
			const workspaceId = await workspaceIdForCwd(cwd);
			const { symbols } = await client.call("workspace.findSymbols", { workspaceId, query });
			return symbols;
		},
	};
}
