import type { ContentHash } from "../domain/content-hash.ts";

/** Which write operation produced this entry -- "revert" is itself a real, further-revertible mutation, not special-cased, matching Neovim's own "U undoes U". */
export type MutationOperation = "exactEdit" | "lineEdit" | "applyPatch" | "revert";

/**
 * One entry in a file's append-only mutation history. Never mutated or deleted once recorded --
 * a revert applies a PAST entry's beforeContent as a brand new entry, it never rewrites or
 * removes history, so a revert is itself always revertible and nothing is ever silently lost
 * (the transferable half of Neovim's undo-tree guarantee, without its branch-pointer machinery,
 * which exists for interactive multi-path exploration this daemon's own single-actor,
 * corrective use case doesn't need).
 */
export interface MutationHistoryEntry {
	readonly id: string;
	readonly path: string;
	readonly operation: MutationOperation;
	/** The file's content immediately before this mutation, or null when the mutation created it (nothing existed before). */
	readonly beforeContent: string | null;
	readonly beforeHash: ContentHash | null;
	/** Null when this mutation's own result was "the file no longer exists" -- reverting a create back to nonexistence is itself a real, valid revert (a delete), matching Neovim's own "u" past the first insert. */
	readonly afterHash: ContentHash | null;
	readonly timestamp: number;
}

export interface CanRevertMutationInputs {
	readonly entry: MutationHistoryEntry;
	/** The file's real current hash, or null if it no longer exists -- comparable directly against a possibly-null afterHash, since "still doesn't exist" is itself a real match. */
	readonly currentHash: ContentHash | null;
}

/**
 * Pure decision, mirroring the same content-hash-guard discipline every other Lector write
 * already uses: a revert is only safe when the file's current content is EXACTLY what this
 * entry's own mutation produced. Anything else -- a later edit, a deletion, anything -- means
 * reverting now would silently clobber a change this entry never knew about, so it's refused.
 */
export function canRevertMutation(inputs: CanRevertMutationInputs): boolean {
	return inputs.currentHash === inputs.entry.afterHash;
}
