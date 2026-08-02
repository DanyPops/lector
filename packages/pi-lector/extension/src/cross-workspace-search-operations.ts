import type { SymbolSearchResult, TextSearchResult, WorkspaceQueryOutcome } from "@danypops/lector";
import { lectorClient, workspaceForProjectDirectory } from "./lector-client.ts";

/**
 * Fans out across explicitly-named directories only -- never the daemon's own "every registered
 * workspace" default. Lector's daemon is a shared, system-wide service: leaving workspaceIds
 * unset would search every project any other concurrent Pi session has ever registered against
 * it, not just this session's own (confirmed live, not assumed -- a real fetched jittor workspace
 * from an unrelated session showed up in an early test of this exact feature). `directories` is
 * required, same "no implicit fallback" convention as find_symbols/search_code.
 */
export interface CrossWorkspaceSearchOperations {
	findSymbols(query: string, directories: readonly string[], timeoutMs?: number): Promise<readonly CrossWorkspaceOutcome<SymbolSearchResult>[]>;
	searchText(
		query: string,
		directories: readonly string[],
		maxMatches: number,
		maxBytes: number,
		timeoutMs?: number,
	): Promise<readonly CrossWorkspaceOutcome<TextSearchResult>[]>;
}

/**
 * One caller-supplied directory's own outcome, labeled back by that literal directory (never
 * just a workspaceId hash) so a caller can tell which of their own inputs a result belongs to.
 * `collapsedWith` lists any OTHER requested directories that resolved to this same workspaceId --
 * empty when this directory got its own distinct scope, as it should for a real monorepo
 * subproject. A caller must be able to tell "two of my inputs turned out to be one workspace"
 * apart from "these are genuinely two separate results" -- silently duplicating one payload
 * under two different-looking entries is exactly the bug this exists to prevent.
 */
export interface CrossWorkspaceOutcome<T> {
	readonly directory: string;
	readonly workspaceId: string;
	readonly collapsedWith: readonly string[];
	readonly outcome: WorkspaceQueryOutcome<T>;
}

async function resolveWorkspaceIds(directories: readonly string[]): Promise<readonly string[]> {
	const resolved = await Promise.all(directories.map((directory) => workspaceForProjectDirectory(directory)));
	return resolved.map((r) => r.workspaceId);
}

/**
 * Zips the daemon's own outcomes back onto the literal directories that produced them, and
 * computes collapsedWith. The daemon's search.symbols/search.text handlers map workspaceIds to
 * results 1:1, in order, with no deduplication of their own (confirmed by reading service.ts's
 * crossFindSymbols/crossSearchText: `targets.map(...)` over the exact `workspaceIds` array
 * given) -- so a length mismatch here means that contract broke, not a normal runtime condition
 * to paper over with an unsafe cast.
 */
function zipOutcomes<T>(
	directories: readonly string[],
	workspaceIds: readonly string[],
	outcomes: readonly WorkspaceQueryOutcome<T>[],
): readonly CrossWorkspaceOutcome<T>[] {
	if (outcomes.length !== directories.length) {
		throw new Error(
			`Lector's search fan-out returned ${outcomes.length} outcome(s) for ${directories.length} requested directories -- expected exactly one outcome per directory, in order`,
		);
	}
	return directories.map((directory, index) => {
		const workspaceId = workspaceIds[index];
		const outcome = outcomes[index];
		if (workspaceId === undefined || outcome === undefined) {
			throw new Error(`Lector's search fan-out is missing a workspaceId/outcome for directory "${directory}"`);
		}
		const collapsedWith = directories.filter((_, otherIndex) => otherIndex !== index && workspaceIds[otherIndex] === workspaceId);
		return { directory, workspaceId, collapsedWith, outcome };
	});
}

export function createLectorCrossWorkspaceSearchOperations(): CrossWorkspaceSearchOperations {
	return {
		async findSymbols(query, directories, timeoutMs) {
			const workspaceIds = await resolveWorkspaceIds(directories);
			const client = await lectorClient();
			const { results } = await client.call("search.symbols", { query, workspaceIds, timeoutMs });
			return zipOutcomes(directories, workspaceIds, results);
		},
		async searchText(query, directories, maxMatches, maxBytes, timeoutMs) {
			const workspaceIds = await resolveWorkspaceIds(directories);
			const client = await lectorClient();
			const { results } = await client.call("search.text", { query, maxMatches, maxBytes, workspaceIds, timeoutMs });
			return zipOutcomes(directories, workspaceIds, results);
		},
	};
}
