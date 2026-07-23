import type { WorkspaceSymbol } from "@danypops/lector";
import { lectorClient, workspaceForDirectory } from "./lector-client.ts";

/**
 * Thin wrapper over workspace.findSymbols. No seedFile parameter here or
 * anywhere above this call: Lector's discoverSeedFile() bounded
 * auto-discovery fully absorbs that tsserver implementation detail, so a
 * pi tool schema (and the model calling it) never needs to know it exists.
 *
 * `directory` is an explicit per-call override, resolved the same way as
 * `defaultDirectory` (nearest enclosing git root, or the directory itself
 * if none) -- omit it to search whatever project the session is running
 * in, or pass a different absolute directory to get code intelligence for
 * a completely different project without needing to be "in" it. A fixed,
 * session-wide-only default was a real, reported limitation: read/write/
 * edit can already touch any repo in one session, and a symbol search had
 * no equivalent escape hatch at all.
 */
export interface FindSymbolsOperations {
	findSymbols(query: string, directory?: string): Promise<readonly WorkspaceSymbol[]>;
}

export function createLectorFindSymbolsOperations(defaultDirectory: string): FindSymbolsOperations {
	return {
		async findSymbols(query, directory) {
			const client = await lectorClient();
			const { workspaceId } = await workspaceForDirectory(directory ?? defaultDirectory);
			const { symbols } = await client.call("workspace.findSymbols", { workspaceId, query });
			return symbols;
		},
	};
}
