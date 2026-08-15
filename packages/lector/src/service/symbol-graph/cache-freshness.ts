import type { GitPort } from "../../git/port.ts";
import { isCacheFreshByGit } from "../../repo-fetcher/git-cache-freshness.ts";
import type { RepoFetcherPort } from "../../repo-fetcher/port.ts";
import { shouldRefetchFromRemote } from "../../repo-fetcher/remote-cache-freshness.ts";
import type { SymbolGraphGeneration } from "../../symbol-graph/symbol-graph-generation.ts";
import type { WorkspaceId } from "../errors.ts";
import type { WarmIndexRegistry } from "../warm-index-registry.ts";
import type { RegisteredWorkspace } from "../workspace-registry.ts";

export interface CacheFreshnessDeps {
	readonly repoFetcher: RepoFetcherPort | undefined;
	readonly createGitPort: (rootPath: string) => GitPort;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
}

export interface CacheFreshnessHelpers {
	captureGitHeadShaIfClean(rootPath: string): Promise<string | undefined>;
	isCacheFreshViaGit(rootPath: string, recordedHeadSha: string): Promise<boolean>;
	closeWarmIndexesForWorkspace(workspaceId: WorkspaceId): Promise<void>;
	refreshRemoteWorkspaceIfMoved(
		workspaceId: WorkspaceId,
		entry: RegisteredWorkspace,
		previousGeneration: SymbolGraphGeneration | undefined,
	): Promise<void>;
}

/**
 * The cache-freshness fast paths shared by population and cache-status: a git-based check that
 * can skip a full source rehash, and remote-tracked-workspace auto-pull-on-demand. Split out of
 * createSymbolGraphHandlers because both population and cache-query need the identical logic and
 * neither owns it.
 */
export function createCacheFreshnessHelpers(deps: CacheFreshnessDeps): CacheFreshnessHelpers {
	const { repoFetcher, createGitPort, warmIndexes } = deps;

	/**
	 * The git HEAD sha to record with a fresh generation, or undefined when the workspace isn't
	 * a git repository or its tree wasn't clean at population time -- either way, no single sha
	 * can honestly represent "the state this generation was built from." Never throws: any git
	 * error just means this workspace's future cache-status checks always pay for a full rehash,
	 * not that population itself should fail.
	 */
	async function captureGitHeadShaIfClean(rootPath: string): Promise<string | undefined> {
		try {
			const git = createGitPort(rootPath);
			if (!(await git.isGitRepository())) return undefined;
			const status = await git.status();
			if (status.files.length > 0) return undefined;
			const [latest] = await git.log(1);
			return latest?.sha;
		} catch {
			return undefined;
		}
	}

	/**
	 * False on any git error, not just a genuine mismatch -- an errored fast-path check must
	 * never be trusted as "fresh," only ever fall back to the full rehash. Deliberately skips a
	 * separate isGitRepository() probe: status()/log() on a non-repo fail on their own, caught
	 * the same way, at one fewer subprocess spawn -- confirmed to matter empirically (a real
	 * measured ~20% of this check's own cost at production-relevant tree sizes), not a guessed
	 * micro-optimization.
	 */
	async function isCacheFreshViaGit(rootPath: string, recordedHeadSha: string): Promise<boolean> {
		try {
			const git = createGitPort(rootPath);
			const status = await git.status();
			const [latest] = await git.log(1);
			return isCacheFreshByGit({ recordedHeadSha, isGitRepository: true, workingTreeClean: status.files.length === 0, currentHeadSha: latest?.sha });
		} catch {
			return false;
		}
	}

	/**
	 * Closes and forgets any warm symbol index for this workspace, without touching another
	 * workspace's. Called after a forced remote refetch replaces the workspace's on-disk
	 * directory wholesale -- an already-warm LSP process (e.g. tsserver) has its own project
	 * state built from the old directory and does not recover from having it swapped out from
	 * under it (confirmed live: querying it afterwards failed with "No Project"). The next
	 * ensureLanguageIndex call for this workspace spawns a fresh process against the new content.
	 */
	async function closeWarmIndexesForWorkspace(workspaceId: WorkspaceId): Promise<void> {
		await warmIndexes.closeWorkspace(workspaceId);
	}

	/**
	 * Auto-pull, on demand, no debounce: every call against a remote-tracked workspace pays one
	 * cheap ls-remote; a real refetch only happens on the call where the remote's commit actually
	 * differs from what the last generation recorded. A no-op for a local workspace, a remote
	 * workspace with no prior generation to compare against, or an inconclusive remote check
	 * (shouldRefetchFromRemote never treats "couldn't tell" as evidence of staleness). The
	 * refetch reuses repoFetcher's own atomic clone-into-tmp-then-rename swap at the exact same
	 * on-disk path this workspace is already registered against, so no registry update is needed
	 * -- the next read of rootPath simply sees the fresh content.
	 */
	async function refreshRemoteWorkspaceIfMoved(
		workspaceId: WorkspaceId,
		entry: RegisteredWorkspace,
		previousGeneration: SymbolGraphGeneration | undefined,
	): Promise<void> {
		if (!entry.remoteReference || !repoFetcher) return;
		const currentRemoteCommit = await repoFetcher.resolveRemoteCommit(entry.remoteReference);
		if (!shouldRefetchFromRemote({ recordedCommit: previousGeneration?.remoteCommit, currentRemoteCommit })) return;
		await repoFetcher.fetch(entry.remoteReference, { forceRefresh: true });
		await closeWarmIndexesForWorkspace(workspaceId);
	}

	return { captureGitHeadShaIfClean, isCacheFreshViaGit, closeWarmIndexesForWorkspace, refreshRemoteWorkspaceIfMoved };
}
