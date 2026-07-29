import type { WorkspacePort } from "../ports/workspace-port.ts";
import type { ContentHash } from "./content-hash.ts";
import type { ParsedWorkspaceEdit, TextEditOperation, WorkspaceEditOperation } from "./workspace-edit.ts";

export class OverlappingWorkspaceEdits extends Error {
	constructor(readonly path: string) {
		super(`overlapping text edits for "${path}" -- refusing to apply them in an order-dependent way`);
		this.name = "OverlappingWorkspaceEdits";
	}
}

export interface ApplyWorkspaceEditOutcome {
	readonly touchedPaths: readonly string[];
}

interface Position {
	readonly line: number;
	readonly character: number;
}

/** 1-indexed line/character -> absolute string offset into `content`, split the same way lineEdit/applyPatch already do (plain "\n", no special CRLF handling). */
function offsetFor(lines: readonly string[], position: Position): number {
	let offset = 0;
	for (let i = 0; i < position.line - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
	return offset + (position.character - 1);
}

/** Applies every edit in one file's own list, rejecting overlaps rather than resolving them order-dependently. Processes from the end backwards so an earlier edit's own offsets are never shifted by a later one's length change. */
function applyTextEdits(content: string, path: string, edits: TextEditOperation["edits"]): string {
	const lines = content.split("\n");
	const withOffsets = edits.map((edit) => ({ edit, start: offsetFor(lines, edit.range.start), end: offsetFor(lines, edit.range.end) }));
	const sorted = [...withOffsets].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		const previous = sorted[i - 1];
		const current = sorted[i];
		if (previous && current && current.start < previous.end) throw new OverlappingWorkspaceEdits(path);
	}
	let result = content;
	for (const { edit, start, end } of [...sorted].reverse()) {
		result = result.slice(0, start) + edit.newText + result.slice(end);
	}
	return result;
}

function touchedPathsOf(edit: ParsedWorkspaceEdit): string[] {
	const paths: string[] = [];
	for (const op of edit.operations) {
		if (op.kind === "text" || op.kind === "create" || op.kind === "delete") paths.push(op.path);
		else paths.push(op.fromPath, op.toPath);
	}
	return paths;
}

/** How to undo one already-applied step: "delete" undoes a fresh creation; "write" restores prior content (expectedHash null means the path didn't exist before this step). */
type Undo =
	| { readonly kind: "delete"; readonly path: string; readonly currentHash: ContentHash }
	| { readonly kind: "write"; readonly path: string; readonly expectedHash: ContentHash | null; readonly content: string };

/**
 * Applies a parsed WorkspaceEdit's operations in order, all-or-nothing, validated against
 * `expectedHashes` -- the hash (or null for "didn't exist") the CALLER observed for each touched
 * path BEFORE deciding this edit was safe to apply (e.g. read once, immediately after receiving
 * the WorkspaceEdit from textDocument/rename). This is deliberately a caller-supplied snapshot,
 * not a fresh read taken here: a fresh read immediately before its own write can never detect a
 * race that happened before this function was even called (it would just see -- and trust -- the
 * already-changed content), which is the actual race this validation exists to catch. A path
 * this edit touches more than once (e.g. create then a text edit on the same new file) chains
 * naturally: the second touch validates against the hash the FIRST touch just produced, not the
 * original snapshot.
 *
 * Any failure rolls back every step already applied (reverse order) before rethrowing, mirroring
 * applyReferenceBasedRename's own proven rollback shape.
 *
 * A bare CreateFile/RenameFile/DeleteFile resource operation carries no version or content
 * signal at all in the LSP wire format (unlike TextDocumentEdit) -- `expectedHashes` is still
 * validated for these (the snapshot the caller captured), but there is no equivalent protection
 * for a change that happens to land in the (typically very small) window between the snapshot
 * and this call for a path that operation is the ONLY thing touching.
 */
export async function applyWorkspaceEdit(
	workspace: WorkspacePort,
	edit: ParsedWorkspaceEdit,
	expectedHashes: ReadonlyMap<string, ContentHash | null>,
): Promise<ApplyWorkspaceEditOutcome> {
	const undos: Undo[] = [];
	const touched = new Set<string>();
	// Tracks what THIS edit believes each path currently holds, seeded from the caller's
	// snapshot and updated as each operation applies -- so a path touched more than once within
	// the same edit chains against its own most recent state, not the original snapshot.
	const believedHash = new Map<string, ContentHash | null>(expectedHashes);

	function expectedHashFor(path: string): ContentHash | null {
		const hash = believedHash.get(path);
		if (hash === undefined) throw new Error(`applyWorkspaceEdit: no expected hash snapshot was given for "${path}"`);
		return hash;
	}

	async function rollback(): Promise<void> {
		for (const undo of [...undos].reverse()) {
			if (undo.kind === "delete") await workspace.deleteEntry(undo.path, undo.currentHash);
			else await workspace.writeEntry(undo.path, undo.expectedHash, undo.content);
		}
	}

	async function applyOne(op: WorkspaceEditOperation): Promise<void> {
		if (op.kind === "text") {
			const expectedHash = expectedHashFor(op.path);
			if (expectedHash === null) throw new Error(`cannot apply a text edit to "${op.path}": it did not exist when this edit was computed`);
			const before = await workspace.readEntry(op.path);
			const beforeContent = before.exists ? before.content : "";
			const newContent = applyTextEdits(beforeContent, op.path, op.edits);
			const written = await workspace.writeEntry(op.path, expectedHash, newContent);
			undos.push({ kind: "write", path: op.path, expectedHash: written.newHash, content: beforeContent });
			believedHash.set(op.path, written.newHash);
			touched.add(op.path);
			return;
		}
		if (op.kind === "create") {
			const expectedHash = expectedHashFor(op.path);
			if (expectedHash !== null) {
				if (op.ignoreIfExists && !op.overwrite) {
					touched.add(op.path);
					return;
				}
				if (!op.overwrite) throw new Error(`cannot create "${op.path}": it already exists`);
				const before = await workspace.readEntry(op.path);
				const written = await workspace.writeEntry(op.path, expectedHash, "");
				undos.push({ kind: "write", path: op.path, expectedHash: written.newHash, content: before.exists ? before.content : "" });
				believedHash.set(op.path, written.newHash);
			} else {
				const written = await workspace.writeEntry(op.path, null, "");
				undos.push({ kind: "delete", path: op.path, currentHash: written.newHash });
				believedHash.set(op.path, written.newHash);
			}
			touched.add(op.path);
			return;
		}
		if (op.kind === "rename") {
			const fromExpectedHash = expectedHashFor(op.fromPath);
			if (fromExpectedHash === null) throw new Error(`cannot rename "${op.fromPath}": it did not exist when this edit was computed`);
			const toExpectedHash = expectedHashFor(op.toPath);
			if (toExpectedHash !== null && !op.overwrite && !op.ignoreIfExists) throw new Error(`cannot rename to "${op.toPath}": it already exists`);
			if (toExpectedHash !== null && op.ignoreIfExists && !op.overwrite) {
				touched.add(op.fromPath);
				touched.add(op.toPath);
				return;
			}
			const before = await workspace.readEntry(op.fromPath);
			const beforeContent = before.exists ? before.content : "";
			const targetBefore = toExpectedHash !== null ? await workspace.readEntry(op.toPath) : undefined;
			const written = await workspace.writeEntry(op.toPath, toExpectedHash, beforeContent);
			undos.push(
				targetBefore?.exists
					? { kind: "write", path: op.toPath, expectedHash: written.newHash, content: targetBefore.content }
					: { kind: "delete", path: op.toPath, currentHash: written.newHash },
			);
			believedHash.set(op.toPath, written.newHash);
			const deleted = await workspace.deleteEntry(op.fromPath, fromExpectedHash);
			undos.push({ kind: "write", path: op.fromPath, expectedHash: null, content: beforeContent });
			believedHash.set(op.fromPath, null);
			void deleted;
			touched.add(op.fromPath);
			touched.add(op.toPath);
			return;
		}
		// op.kind === "delete"
		const expectedHash = expectedHashFor(op.path);
		if (expectedHash === null) {
			if (op.ignoreIfNotExists) return;
			throw new Error(`cannot delete "${op.path}": it did not exist when this edit was computed`);
		}
		const before = await workspace.readEntry(op.path);
		const beforeContent = before.exists ? before.content : "";
		await workspace.deleteEntry(op.path, expectedHash);
		undos.push({ kind: "write", path: op.path, expectedHash: null, content: beforeContent });
		believedHash.set(op.path, null);
		touched.add(op.path);
	}

	try {
		for (const op of edit.operations) await applyOne(op);
		return { touchedPaths: [...touched] };
	} catch (error) {
		await rollback();
		throw error;
	}
}

/** Every distinct path a WorkspaceEdit touches -- the exact set a caller must snapshot into `expectedHashes` before calling applyWorkspaceEdit. */
export function collectTouchedPaths(edit: ParsedWorkspaceEdit): readonly string[] {
	return [...new Set(touchedPathsOf(edit))];
}
