import { createHash } from "node:crypto";

/** Identifies one cached search: which workspace, what query, under what bounds. */
export interface SearchCacheKey {
	readonly workspaceId: string;
	readonly query: string;
	readonly maxMatches: number;
	readonly maxBytes: number;
}

/** Deterministic string key for a SearchCacheKey -- same fields always yield the same key, across adapters and process restarts. */
export function deriveSearchCacheKey(key: SearchCacheKey): string {
	return createHash("sha256")
		.update(JSON.stringify({ workspaceId: key.workspaceId, query: key.query, maxMatches: key.maxMatches, maxBytes: key.maxBytes }))
		.digest("hex");
}
