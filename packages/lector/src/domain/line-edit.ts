import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { type LineHash, lineHashOf } from "../content-identity/line-hash.ts";
import type { WorkspacePort } from "../ports/workspace-port.ts";
import { WorkspaceEntryNotFound } from "./raw-read.ts";

/** Replaces the inclusive line range [startLine, endLine] with `lines` -- an empty `lines` array deletes the range. */
export interface LineEditReplace {
	readonly kind: "replace";
	readonly startLine: number;
	readonly endLine: number;
	readonly expectedStartHash: LineHash;
	readonly expectedEndHash: LineHash;
	readonly lines: readonly string[];
}

/** Inserts `lines` immediately before `atLine`, which must still hold `expectedHash`. */
export interface LineEditInsertBefore {
	readonly kind: "insertBefore";
	readonly atLine: number;
	readonly expectedHash: LineHash;
	readonly lines: readonly string[];
}

/** Inserts `lines` immediately after `atLine`, which must still hold `expectedHash`. */
export interface LineEditInsertAfter {
	readonly kind: "insertAfter";
	readonly atLine: number;
	readonly expectedHash: LineHash;
	readonly lines: readonly string[];
}

export type LineEdit = LineEditReplace | LineEditInsertBefore | LineEditInsertAfter;

export interface LineEditRequest {
	readonly path: string;
	readonly edits: readonly LineEdit[];
}

/** The committed result of a lineEdit, same shape as exactEdit's EditOutcome. */
export interface LineEditOutcome {
	readonly path: string;
	readonly previousHash: ContentHash;
	readonly newHash: ContentHash;
}

export type LineEditFailureReason = "out-of-bounds" | "hash-mismatch" | "embedded-newline" | "overlapping-edits";

/** One edit's specific validation failure, identified by its position in the request's own edits array. */
export interface LineEditFailure {
	readonly editIndex: number;
	readonly reason: LineEditFailureReason;
	readonly message: string;
	/** Present only for hash-mismatch: the line's real current hash, so a caller can retry without a fresh whole-file read. */
	readonly actualHash?: LineHash;
}

/**
 * Raised when any edit in the batch fails validation -- all-or-nothing, the same atomicity
 * exactEdit already gives a single whole-file write, just applied across a batch of finer-
 * grained edits instead of one coarse one. Carries every failure found, not just the first,
 * so a caller can fix every problem in one round trip instead of discovering them one at a time.
 *
 * The message itself spells out every failure inline, not just a count: a daemon RPC boundary
 * carries only a single flattened error string (see client.ts's remoteErrorIs doc comment), so
 * the `failures` array below is only ever visible to a same-process caller of this domain
 * function directly -- a caller across the wire (the CLI, a Pi tool) sees only this message,
 * which must therefore already be the full, actionable answer on its own.
 */
export class LineEditRejected extends Error {
	constructor(
		readonly path: string,
		readonly failures: readonly LineEditFailure[],
	) {
		const details = failures.map((failure) => `  edit ${failure.editIndex}: ${failure.reason} -- ${failure.message}`).join("\n");
		super(`lineEdit at "${path}" rejected: ${failures.length} of its edits failed validation\n${details}`);
		this.name = "LineEditRejected";
	}
}

/**
 * Raised when the underlying whole-file write itself loses a race against a genuinely
 * concurrent write that landed between this operation's own read and write -- a real but
 * narrow window, distinct from (and far rarer than) the "any earlier, unrelated line changed"
 * problem lineEdit exists to avoid. The caller's own referenced lines were valid when checked;
 * retrying (fresh read, fresh validation) is the correct response, not treating this the same
 * as a semantic hash-mismatch.
 */
export class LineEditRace extends Error {
	constructor(readonly path: string) {
		super(`lineEdit at "${path}" lost a race against a concurrent write between its own read and write -- retry`);
		this.name = "LineEditRace";
	}
}

function splicePosition(edit: LineEdit): number {
	switch (edit.kind) {
		case "replace":
			return edit.startLine - 1;
		case "insertBefore":
			return edit.atLine - 1;
		case "insertAfter":
			return edit.atLine;
	}
}

function occupiedRange(edit: LineEdit): { start: number; end: number } {
	// end is exclusive, matching the splice range this edit will actually touch -- an insert
	// touches a zero-width point, a replace touches its own inclusive line range.
	if (edit.kind === "replace") return { start: edit.startLine - 1, end: edit.endLine };
	const position = splicePosition(edit);
	return { start: position, end: position };
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end;
}

/**
 * Validates every edit against `lines` (the file's current, freshly-read content) without
 * mutating it, so every edit is checked against the SAME snapshot regardless of file-order --
 * exactly the point of per-line hashes over a single whole-file hash.
 */
function validate(lines: readonly string[], edits: readonly LineEdit[]): LineEditFailure[] {
	const failures: LineEditFailure[] = [];

	function checkLine(editIndex: number, lineNumber: number, expected: LineHash): void {
		if (lineNumber < 1 || lineNumber > lines.length) {
			failures.push({ editIndex, reason: "out-of-bounds", message: `line ${lineNumber} is out of bounds (file has ${lines.length} lines)` });
			return;
		}
		const actual = lineHashOf(lines[lineNumber - 1] ?? "");
		if (actual !== expected) {
			failures.push({
				editIndex,
				reason: "hash-mismatch",
				message: `line ${lineNumber} changed since last read (expected ${expected}, found ${actual})`,
				actualHash: actual,
			});
		}
	}

	edits.forEach((edit, editIndex) => {
		for (const line of edit.lines) {
			if (line.includes("\n")) {
				failures.push({
					editIndex,
					reason: "embedded-newline",
					message: "an edit's own lines must not contain an embedded newline -- one array entry is exactly one line",
				});
				return;
			}
		}
		if (edit.kind === "replace") {
			if (edit.startLine < 1 || edit.endLine < edit.startLine) {
				failures.push({ editIndex, reason: "out-of-bounds", message: `invalid line range ${edit.startLine}-${edit.endLine}` });
				return;
			}
			checkLine(editIndex, edit.startLine, edit.expectedStartHash);
			if (edit.endLine !== edit.startLine) checkLine(editIndex, edit.endLine, edit.expectedEndHash);
			else if (edit.expectedEndHash !== edit.expectedStartHash) {
				failures.push({ editIndex, reason: "hash-mismatch", message: "a single-line replace's expectedStartHash and expectedEndHash must be identical" });
			}
		} else {
			checkLine(editIndex, edit.atLine, edit.expectedHash);
		}
	});

	edits.forEach((first, i) => {
		for (const [j, second] of edits.slice(i + 1).entries()) {
			if (rangesOverlap(occupiedRange(first), occupiedRange(second))) {
				const secondIndex = i + 1 + j;
				failures.push({
					editIndex: secondIndex,
					reason: "overlapping-edits",
					message: `edit ${secondIndex} overlaps edit ${i}'s own line range -- split into separate lineEdit calls`,
				});
			}
		}
	});

	return failures;
}

function apply(lines: readonly string[], edits: readonly LineEdit[]): string[] {
	const result = [...lines];
	// Apply from the highest splice position downward so an earlier splice's own length
	// change never invalidates a not-yet-applied edit's line numbers -- the same bottom-up
	// approach a comparable design in a sibling project already uses.
	const ordered = [...edits].sort((a, b) => splicePosition(b) - splicePosition(a));
	for (const edit of ordered) {
		const position = splicePosition(edit);
		if (edit.kind === "replace") result.splice(position, edit.endLine - edit.startLine + 1, ...edit.lines);
		else result.splice(position, 0, ...edit.lines);
	}
	return result;
}

/**
 * Applies a batch of per-line-hash-guarded edits to one workspace entry, atomically: every
 * edit is validated against the same freshly-read snapshot, and either all of them land or
 * none do. Unlike exactEdit, no whole-file expectedHash is required from the caller -- each
 * edit's own line-hash(es) are the guard, so a concurrent change to a line no edit references
 * never invalidates this one. The underlying write is still a real compare-and-swap against
 * the content actually read (via WorkspacePort.writeEntry), so a genuinely concurrent write is
 * still never silently lost -- it surfaces as LineEditRace, not a corrupted file.
 */
export async function lineEdit(workspace: WorkspacePort, request: LineEditRequest): Promise<LineEditOutcome> {
	if (request.edits.length === 0) throw new TypeError("lineEdit requires at least one edit");
	const entry = await workspace.readEntry(request.path);
	if (!entry.exists) throw new WorkspaceEntryNotFound(request.path);

	const lines = entry.content.split("\n");
	const failures = validate(lines, request.edits);
	if (failures.length > 0) throw new LineEditRejected(request.path, failures);

	const newContent = apply(lines, request.edits).join("\n");
	const currentHash = contentHashOf(entry.content);
	try {
		const { previousHash, newHash } = await workspace.writeEntry(request.path, currentHash, newContent);
		// previousHash is only ever null when expectedHash was null (a create); currentHash is a
		// real hash of content we just confirmed exists, so a successful write here always has one.
		if (previousHash === null) throw new TypeError("unreachable: writeEntry reported no previous content for an entry lineEdit just read");
		return { path: request.path, previousHash, newHash };
	} catch (error) {
		if (error instanceof Error && error.name === "StaleExpectedHash") throw new LineEditRace(request.path);
		throw error;
	}
}
