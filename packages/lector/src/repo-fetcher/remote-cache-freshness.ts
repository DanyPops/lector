/**
 * Pure decision: has a remote-tracked workspace's origin moved past what its symbol-graph
 * generation was populated against? Unlike the local git fast path (isCacheFreshByGit), an
 * inconclusive current commit -- the remote couldn't be reached, the tracked ref doesn't
 * resolve to a moving branch (e.g. it's already an exact commit sha) -- must NOT mean "assume
 * stale." There is no cheap, reliable local fallback the way a full source rehash backs up a
 * failed local git read: forcing a refetch on every transient network hiccup would make
 * querying a remote workspace unusable the moment connectivity blips, which is strictly worse
 * than serving the last known-good cache. Only a genuine, positively observed commit mismatch
 * triggers a refetch.
 */
export interface RemoteCacheFreshnessInputs {
	readonly recordedCommit: string | undefined;
	readonly currentRemoteCommit: string | undefined;
}

export function shouldRefetchFromRemote(inputs: RemoteCacheFreshnessInputs): boolean {
	if (inputs.recordedCommit === undefined) return false;
	if (inputs.currentRemoteCommit === undefined) return false;
	return inputs.currentRemoteCommit !== inputs.recordedCommit;
}
