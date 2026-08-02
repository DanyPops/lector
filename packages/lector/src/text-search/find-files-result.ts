/** `truncated` is honest, not silent: true whenever maxResults or maxBytes cut the listing short. */
export interface FindFilesResult {
	/** Workspace-relative paths, matching any of the given glob patterns. */
	readonly paths: readonly string[];
	readonly truncated: boolean;
}
