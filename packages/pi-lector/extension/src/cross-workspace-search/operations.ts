import { type SymbolSearchResult, type TextSearchResult, UnknownWorkspace, type WorkspaceQueryOutcome } from "@danypops/lector";
import { forgetWorkspaceId, lectorClient, type ResolvedWorkspace, workspaceForProjectDirectory } from "../lector-client.ts";

/**
 * Fans out across explicitly-named directories only -- never the daemon's own "every registered
 * workspace" default. Lector's daemon is a shared, system-wide service: leaving workspaceIds
 * unset would search every project any other concurrent Pi session has ever registered against
 * it, not just this session's own (confirmed live, not assumed -- a real fetched jittor workspace
 * from an unrelated session showed up in an early test of this exact feature). `directories` is
 * required, same "no implicit fallback" convention as find_symbols/search_code.
 */
export interface CrossWorkspaceSearchOperations {
	/** maxResults, when given, applies per project (see workspace.cacheStatus's own OperationInputs note on search.symbols) -- omitted falls back to the daemon's own conservative default, never an unbounded per-project search.symbols call fanned out across every requested directory at once. */
	findSymbols(
		query: string,
		directories: readonly string[],
		timeoutMs?: number,
		maxResults?: number,
	): Promise<readonly CrossWorkspaceOutcome<SymbolSearchResult>[]>;
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

function resolveWorkspaces(directories: readonly string[]): Promise<readonly ResolvedWorkspace[]> {
	return Promise.all(directories.map((directory) => workspaceForProjectDirectory(directory)));
}

/**
 * Zips the daemon's own outcomes back onto the literal directories that produced them, and
 * computes collapsedWith -- by workspaceId identity, never by array position. A real, reproduced
 * live bug: the daemon's own response order can legitimately differ from the request's
 * workspaceIds order (an immediate per-item error for an unregistered id is reported ahead of
 * real results, for instance) -- a caller correlating positionally then hands one directory's
 * result to a completely different directory. Every outcome already carries its own workspaceId;
 * this groups outcomes by that id (preserving arrival order *within* one id's own group, since
 * two directories can legitimately share one workspaceId -- a monorepo's unmarked siblings) and
 * consumes exactly one outcome per requested (directory, workspaceId) pair in that group, in
 * order. A missing, duplicated-beyond-what-was-asked, or wholly unrequested workspaceId in the
 * response means the daemon's contract broke -- fails loud rather than silently mislabeling or
 * dropping data.
 */
function zipOutcomes<T>(
	directories: readonly string[],
	workspaceIds: readonly string[],
	outcomes: readonly WorkspaceQueryOutcome<T>[],
): readonly CrossWorkspaceOutcome<T>[] {
	if (outcomes.length !== directories.length) {
		throw new Error(
			`Lector's search fan-out returned ${outcomes.length} outcome(s) for ${directories.length} requested directories -- expected exactly one outcome per directory`,
		);
	}
	const outcomesByWorkspaceId = new Map<string, WorkspaceQueryOutcome<T>[]>();
	for (const outcome of outcomes) {
		const bucket = outcomesByWorkspaceId.get(outcome.workspaceId);
		if (bucket) bucket.push(outcome);
		else outcomesByWorkspaceId.set(outcome.workspaceId, [outcome]);
	}
	const consumedByWorkspaceId = new Map<string, number>();
	const results = directories.map((directory, index) => {
		const workspaceId = workspaceIds[index];
		if (workspaceId === undefined) throw new Error(`Lector's search fan-out is missing a resolved workspaceId for directory "${directory}"`);
		const consumed = consumedByWorkspaceId.get(workspaceId) ?? 0;
		const outcome = outcomesByWorkspaceId.get(workspaceId)?.[consumed];
		if (!outcome) {
			throw new Error(
				`Lector's search fan-out returned no outcome for workspace "${workspaceId}" (directory "${directory}") -- the daemon's response no longer corresponds to the request`,
			);
		}
		consumedByWorkspaceId.set(workspaceId, consumed + 1);
		const collapsedWith = directories.filter((_, otherIndex) => otherIndex !== index && workspaceIds[otherIndex] === workspaceId);
		return { directory, workspaceId, collapsedWith, outcome };
	});
	const totalConsumed = [...consumedByWorkspaceId.values()].reduce((sum, count) => sum + count, 0);
	if (totalConsumed !== outcomes.length) {
		throw new Error(
			"Lector's search fan-out returned an outcome for a workspace nobody asked for -- the daemon's response no longer corresponds to the request",
		);
	}
	return results;
}

/** True exactly for the daemon's own "this workspaceId is not registered" outcome for this request's own workspaceId -- never a string-matched guess against an unrelated error. */
function isUnknownWorkspaceOutcome<T>(outcome: WorkspaceQueryOutcome<T>, workspaceId: string): boolean {
	return outcome.status === "error" && outcome.message === new UnknownWorkspace(workspaceId).message;
}

/**
 * A daemon restart wipes its in-memory workspace registry, but this process's own workspaceId
 * cache does not know that on its own -- a cross-workspace call through a stale cached id comes
 * back with a real, correctly-correlated "no workspace registered" outcome for that one
 * workspace, even though the underlying directory on disk never changed. On exactly that
 * outcome, the stale cache entries are dropped and the whole fan-out (re-resolve every
 * directory, then re-run) retries once -- the same bounded, idempotent recovery withWorkspace
 * already gives single-workspace operations, extended to a batch. A genuine per-workspace error
 * unrelated to registration (an unsupported language, a real internal failure) is never retried.
 */
async function withCrossWorkspaceRestartRecovery<T>(
	directories: readonly string[],
	perform: (resolved: readonly ResolvedWorkspace[]) => Promise<readonly CrossWorkspaceOutcome<T>[]>,
): Promise<readonly CrossWorkspaceOutcome<T>[]> {
	const resolved = await resolveWorkspaces(directories);
	const outcomes = await perform(resolved);
	const stale = outcomes.filter((entry) => isUnknownWorkspaceOutcome(entry.outcome, entry.workspaceId));
	if (stale.length === 0) return outcomes;
	for (const entry of stale) {
		const match = resolved.find((candidate) => candidate.workspaceId === entry.workspaceId);
		if (match) forgetWorkspaceId(match.root);
	}
	return perform(await resolveWorkspaces(directories));
}

export function createLectorCrossWorkspaceSearchOperations(): CrossWorkspaceSearchOperations {
	return {
		findSymbols(query, directories, timeoutMs, maxResults) {
			return withCrossWorkspaceRestartRecovery(directories, async (resolved) => {
				const workspaceIds = resolved.map((r) => r.workspaceId);
				const client = await lectorClient();
				const { results } = await client.call("search.symbols", { query, workspaceIds, timeoutMs, ...(maxResults !== undefined ? { maxResults } : {}) });
				return zipOutcomes(directories, workspaceIds, results);
			});
		},
		searchText(query, directories, maxMatches, maxBytes, timeoutMs) {
			return withCrossWorkspaceRestartRecovery(directories, async (resolved) => {
				const workspaceIds = resolved.map((r) => r.workspaceId);
				const client = await lectorClient();
				const { results } = await client.call("search.text", { query, maxMatches, maxBytes, workspaceIds, timeoutMs });
				return zipOutcomes(directories, workspaceIds, results);
			});
		},
	};
}
