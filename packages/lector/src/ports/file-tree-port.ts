/** What kind of thing a directory entry is -- affects rendering (a trailing "/") and navigation (Enter descends vs. opens). */
export type FileTreeEntryKind = "file" | "directory" | "symlink";

/** One immediate child of a listed directory. Bare name, never a path -- the caller already knows the parent it asked for. */
export interface FileTreeEntry {
	readonly name: string;
	readonly kind: FileTreeEntryKind;
}

/**
 * FileTreePort -- directory-tree structure and mutation, distinct from WorkspacePort's flat
 * file-content model (readEntry/writeEntry/deleteEntry). Kept as its own port rather than folded
 * into WorkspacePort: a workspace backed by a fetched, read-only checkout has no reason to be
 * forced to implement tree mutation it will only ever reject.
 *
 * File create/delete already exist on WorkspacePort (writeEntry(path, null, content),
 * deleteEntry) and are reused as-is -- this port only adds what WorkspacePort has no way to
 * express: listing a directory's own children, and directory-level create/rename/delete.
 */
export interface FileTreePort {
	/** Immediate children of `path` ("" or "." for the workspace root) -- never recursive. */
	listDirectory(path: string): Promise<FileTreeEntry[]>;

	/** mkdir -p semantics: creates every missing intermediate directory. A no-op if `path` already exists as a directory. */
	createDirectory(path: string): Promise<void>;

	/**
	 * Atomically moves a file or directory. Rejects if the destination already exists -- a real
	 * concurrent-write hazard for two entries with the same name, even though (unlike
	 * WorkspacePort.writeEntry) there is no content hash to guard it with.
	 */
	renamePath(oldPath: string, newPath: string): Promise<void>;

	/**
	 * Recursively removes a directory and everything under it. Deliberately NOT hash-guarded --
	 * a directory has no single content hash to guard with. The confirm-before-apply step this
	 * needs lives in the caller (the /editor explorer's own :w confirmation), not here.
	 */
	deleteDirectory(path: string): Promise<void>;
}

/** Raised by renamePath when the source does not exist -- nothing to move. */
export class WorkspaceEntryDoesNotExist extends Error {
	constructor(readonly path: string) {
		super(`no entry at "${path}" to move`);
		this.name = "WorkspaceEntryDoesNotExist";
	}
}

/** Raised by renamePath when the destination already exists -- never silently overwritten. */
export class WorkspaceEntryAlreadyExists extends Error {
	constructor(readonly path: string) {
		super(`an entry already exists at "${path}"`);
		this.name = "WorkspaceEntryAlreadyExists";
	}
}
