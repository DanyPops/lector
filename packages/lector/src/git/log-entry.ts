/** One commit from `git log`. */
export interface GitLogEntry {
	readonly sha: string;
	readonly authorName: string;
	readonly authorEmail: string;
	/** ISO 8601, as git itself reports it -- never reformatted, to keep timezone info intact. */
	readonly authoredAt: string;
	readonly message: string;
}
