import { createHash } from "node:crypto";

/**
 * LineHash — a fingerprint of one line's exact content, for finer-grained
 * edit guards than ContentHash's whole-file scope. Deliberately NOT trimmed
 * of trailing whitespace (unlike a comparable design in a sibling project):
 * Lector's own exactEdit is byte-exact, and a line-hash guard that treated
 * "trailing whitespace added" as unchanged would silently accept a real
 * content change as if nothing happened -- exactly the kind of fuzziness
 * this codebase avoids everywhere else.
 *
 * SHA-256 truncated to 8 hex characters (32 bits), not 4 (16 bits, as a
 * sibling project's own line-hash scheme uses) -- the shorter length has a
 * real, non-theoretical collision risk in a file with more than a few
 * thousand lines; 8 characters keeps the same "short enough to read/type"
 * property at a collision probability low enough not to matter in practice.
 */
export type LineHash = string & { readonly __brand: "LineHash" };

const LINE_HASH_LENGTH = 8;

/** Compute the LineHash for one line's exact content (no trailing-whitespace normalization). */
export function lineHashOf(line: string): LineHash {
	return createHash("sha256").update(line, "utf-8").digest("hex").slice(0, LINE_HASH_LENGTH) as LineHash;
}
