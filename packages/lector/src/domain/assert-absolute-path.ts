import { isAbsolute } from "node:path";

/**
 * Raised when a caller-supplied path reaches a daemon operation without being absolute already.
 * A long-running daemon has no meaningful "current directory" of its own that a relative path
 * could honestly resolve against -- Node's single-argument `resolve()` would silently use the
 * daemon PROCESS's own cwd (fixed at service-start time, unrelated to any real caller), not the
 * caller's. Confirmed live: `lector workspace register .` silently registered the daemon's own
 * cwd instead of the invoking shell's directory. Rejecting outright, not guessing, is the only
 * honest option at this trust boundary -- the caller (a CLI, an SDK, a future adapter) is the
 * only party that ever actually knows its own real working directory.
 */
export class RelativeWorkspacePath extends Error {
	constructor(readonly path: string) {
		super(`path "${path}" must be absolute -- a daemon has no caller-relative "current directory" of its own to resolve it against`);
		this.name = "RelativeWorkspacePath";
	}
}

export function assertAbsolutePath(path: string): void {
	if (!isAbsolute(path)) throw new RelativeWorkspacePath(path);
}
