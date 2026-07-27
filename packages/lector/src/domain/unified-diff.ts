/**
 * One hunk's own before/after line sequences, in real unified-diff terms.
 * `oldStart` is the hunk header's own claimed 1-indexed starting line in the
 * PRE-patch file -- a hint for where to search, never trusted blindly (see
 * applyPatch's own hunk-context matching, which searches for the actual
 * before-sequence rather than assuming the header's line numbers are still
 * accurate against a file that may have shifted since the diff was made).
 */
export interface UnifiedDiffHunk {
	readonly oldStart: number;
	/** Context + removed lines, in file order -- what must currently be present for this hunk to apply. */
	readonly beforeLines: readonly string[];
	/** Context + added lines, in file order -- what replaces beforeLines once found. */
	readonly afterLines: readonly string[];
}

export class InvalidUnifiedDiff extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidUnifiedDiff";
	}
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses real unified-diff hunks (the `@@ -a,b +c,d @@` format `diff -u`/`git diff` produce)
 * for one file. File-header lines (`--- a/...`, `+++ b/...`), when present, are skipped --
 * applyPatch already takes the target path as its own explicit parameter, so they're
 * informational at most, never load-bearing. Requires at least one real hunk.
 */
export function parseUnifiedDiff(patchText: string): UnifiedDiffHunk[] {
	// A trailing "\n" is normal string termination for patch text (unlike file content, where
	// it legitimately means "the file ends with a blank line") -- strip exactly one before
	// splitting, or split() would manufacture a spurious final empty "line" no real diff tool
	// ever emitted, misread as a genuine blank context line.
	const lines = patchText.replace(/\n$/, "").split("\n");
	const hunks: UnifiedDiffHunk[] = [];
	let current: { oldStart: number; before: string[]; after: string[] } | undefined;

	function flush(): void {
		if (current) hunks.push({ oldStart: current.oldStart, beforeLines: current.before, afterLines: current.after });
		current = undefined;
	}

	for (const line of lines) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		const header = HUNK_HEADER.exec(line);
		if (header) {
			flush();
			current = { oldStart: Number(header[1]), before: [], after: [] };
			continue;
		}
		if (!current) continue; // stray text before the first real hunk (e.g. a commit-message-style preamble) is ignored, not an error
		if (line.startsWith("-")) current.before.push(line.slice(1));
		else if (line.startsWith("+")) current.after.push(line.slice(1));
		else if (line.startsWith(" ")) {
			current.before.push(line.slice(1));
			current.after.push(line.slice(1));
		}
		// A genuinely empty line inside a hunk body (no prefix at all) is treated as a blank
		// context line -- real diff output always prefixes every hunk-body line, but a
		// hand-written or lightly-edited patch dropping the leading space on a truly blank
		// line is common enough to tolerate rather than reject outright.
		else if (line === "") {
			current.before.push("");
			current.after.push("");
		}
	}
	flush();

	if (hunks.length === 0) throw new InvalidUnifiedDiff("no @@ hunks found -- expected real unified-diff output (diff -u / git diff)");
	return hunks;
}
