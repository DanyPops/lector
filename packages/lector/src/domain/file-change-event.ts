/** One real filesystem change under a watched workspace root. */
export interface FileChangeEvent {
	/** Workspace-relative path. */
	readonly path: string;
	readonly kind: "created" | "modified" | "deleted";
}
