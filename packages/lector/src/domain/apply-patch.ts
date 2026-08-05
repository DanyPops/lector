import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import type { WorkspacePort } from "../ports/workspace-port.ts";
import type { EditOutcome } from "./exact-edit.ts";
import { StaleExpectedHash } from "./exact-edit.ts";
import { WorkspaceEntryNotFound } from "./raw-read.ts";
import { parseUnifiedDiff, type UnifiedDiffHunk } from "./unified-diff.ts";

export interface ApplyPatchRequest {
	readonly path: string;
	/** The hash the caller last observed at `path` -- same staleness-guard discipline as exactEdit, required (a patch inherently needs a known pre-image, unlike exactEdit's null-for-create case). */
	readonly expectedHash: ContentHash;
	readonly patchText: string;
}

/**
 * Raised when a hunk's own before-context can no longer be found anywhere in the current file
 * -- the file drifted too far from what the patch was generated against. Only the first
 * unmatchable hunk is reported: unlike lineEdit's independent per-edit validation against one
 * static snapshot, hunks are inherently sequential (each one's search position depends on every
 * earlier hunk having already applied), so a later hunk's own failure-or-not is genuinely
 * undefined once an earlier one fails -- nothing meaningful to report about it yet.
 */
export class PatchRejected extends Error {
	constructor(
		readonly path: string,
		readonly hunkIndex: number,
		readonly hunk: UnifiedDiffHunk,
	) {
		const preview = hunk.beforeLines.slice(0, 3).join("\\n");
		const truncated = hunk.beforeLines.length > 3 ? "..." : "";
		super(
			`applyPatch at "${path}" rejected: hunk ${hunkIndex} (near original line ${hunk.oldStart}) not found in the current file -- context "${preview}${truncated}" no longer matches`,
		);
		this.name = "PatchRejected";
	}
}

/**
 * Finds where `beforeLines` occurs as a contiguous run in `lines`, searching outward from
 * `hint` (nearest first) rather than trusting the hunk header's line number outright -- the
 * same "more forgiving than pure line-offset" hunk-context matching a comparable design in a
 * sibling project already uses, just with the hint driving search order instead of always
 * scanning from the top (avoiding picking the wrong occurrence when the same context text
 * appears more than once in the file). A hunk with no context at all (pure insertion, e.g. a
 * brand-new function added at the top of a file) trivially matches everywhere -- trust the hint
 * position directly in that case, there is nothing else to disambiguate against.
 */
function findHunkPosition(lines: readonly string[], beforeLines: readonly string[], hint: number): number | undefined {
	if (beforeLines.length === 0) return Math.max(0, Math.min(hint, lines.length));

	function matchesAt(start: number): boolean {
		if (start < 0 || start + beforeLines.length > lines.length) return false;
		for (let i = 0; i < beforeLines.length; i++) if (lines[start + i] !== beforeLines[i]) return false;
		return true;
	}

	if (matchesAt(hint)) return hint;
	for (let radius = 1; radius <= lines.length; radius++) {
		if (matchesAt(hint - radius)) return hint - radius;
		if (matchesAt(hint + radius)) return hint + radius;
	}
	return undefined;
}

/**
 * Applies a real unified diff's hunks to one workspace entry, guarded by a whole-file
 * expectedHash (a patch inherently describes a whole-file transformation from one known
 * pre-image, unlike lineEdit's independent per-referenced-line guards -- see that module's own
 * doc comment for when the finer-grained alternative is the better fit). Hunks apply in order
 * against a running in-memory copy; the very first hunk whose context can no longer be found
 * aborts the whole patch before anything is written.
 */
export async function applyPatch(workspace: WorkspacePort, request: ApplyPatchRequest): Promise<EditOutcome> {
	const entry = await workspace.readEntry(request.path);
	if (!entry.exists) throw new WorkspaceEntryNotFound(request.path);
	const currentHash = contentHashOf(entry.content);
	if (currentHash !== request.expectedHash) throw new StaleExpectedHash(request.path, request.expectedHash, currentHash);

	const hunks = parseUnifiedDiff(request.patchText);
	let lines: readonly string[] = entry.content.split("\n");
	let offset = 0;

	for (const [index, hunk] of hunks.entries()) {
		const hint = hunk.oldStart - 1 + offset;
		const position = findHunkPosition(lines, hunk.beforeLines, hint);
		if (position === undefined) throw new PatchRejected(request.path, index, hunk);
		lines = [...lines.slice(0, position), ...hunk.afterLines, ...lines.slice(position + hunk.beforeLines.length)];
		offset += hunk.afterLines.length - hunk.beforeLines.length;
	}

	const newContent = lines.join("\n");
	const { previousHash, newHash } = await workspace.writeEntry(request.path, request.expectedHash, newContent);
	return { path: request.path, previousHash, newHash };
}
