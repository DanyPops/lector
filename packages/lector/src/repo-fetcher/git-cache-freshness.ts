/**
 * Pure decision: is a symbol-graph generation's git-recorded HEAD sha still
 * trustworthy proof that nothing changed, without paying for a full source
 * rehash? All four inputs must hold -- a missing recorded sha, a dirty tree,
 * a moved HEAD, or an undeterminable current sha each independently mean
 * "cannot prove freshness this way," never "assume fresh."
 */
export interface GitCacheFreshnessInputs {
	/** Undefined when the workspace wasn't a git repo, or was dirty, at population time -- a dirty tree has no single sha representing it. */
	readonly recordedHeadSha: string | undefined;
	readonly isGitRepository: boolean;
	readonly workingTreeClean: boolean;
	/** Undefined when the current HEAD sha could not be determined (e.g. an empty repository with no commits yet). */
	readonly currentHeadSha: string | undefined;
}

export function isCacheFreshByGit(inputs: GitCacheFreshnessInputs): boolean {
	if (inputs.recordedHeadSha === undefined) return false;
	if (!inputs.isGitRepository) return false;
	if (!inputs.workingTreeClean) return false;
	if (inputs.currentHeadSha === undefined) return false;
	return inputs.currentHeadSha === inputs.recordedHeadSha;
}
