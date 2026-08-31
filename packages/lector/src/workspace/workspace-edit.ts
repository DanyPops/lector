import type { CodeRange } from "./code-range.ts";

/** Raised when an edit carries a shape this client does not understand well enough to apply safely -- e.g. a vendor snippet-syntax extension to TextEdit. Failing loudly beats silently applying `$1`/`${1:placeholder}` snippet syntax as if it were plain text. */
export class UnsupportedWorkspaceEditVariant extends Error {
	constructor(readonly detail: string) {
		super(`unsupported WorkspaceEdit variant: ${detail}`);
		this.name = "UnsupportedWorkspaceEditVariant";
	}
}

export interface RenameRange {
	/** Absent only for {defaultBehavior: true} -- a valid rename position with no specific range; the client should compute its own from the position it already queried. */
	readonly range: CodeRange | undefined;
	readonly placeholder: string | undefined;
}

/**
 * Parses textDocument/prepareRename's result: a bare Range, {range, placeholder}, {defaultBehavior:
 * true} (valid position, no specific range -- the client should compute its own), or null ("not
 * valid here"). Any other shape is treated the same as null -- never valid by accident.
 */
export function parsePrepareRenameResult(raw: unknown, path: string): RenameRange | null {
	if (raw === null || raw === undefined) return null;
	if (!isRecord(raw)) return null;
	if (raw.defaultBehavior === true) return { range: undefined, placeholder: undefined };
	if (isLspRange(raw)) return { range: toCodeRange(raw, path), placeholder: undefined };
	if (isLspRange(raw.range) && (raw.placeholder === undefined || typeof raw.placeholder === "string")) {
		return { range: toCodeRange(raw.range, path), placeholder: raw.placeholder };
	}
	return null;
}

export interface TextEditOperation {
	readonly kind: "text";
	readonly path: string;
	/** LSP document version the server computed this edit against; absent for a plain changes map. */
	readonly version?: number | null;
	readonly edits: readonly { readonly range: { readonly start: LspLikePosition; readonly end: LspLikePosition }; readonly newText: string }[];
}
export interface CreateFileOperation {
	readonly kind: "create";
	readonly path: string;
	readonly overwrite: boolean;
	readonly ignoreIfExists: boolean;
}
export interface RenameFileOperation {
	readonly kind: "rename";
	readonly fromPath: string;
	readonly toPath: string;
	readonly overwrite: boolean;
	readonly ignoreIfExists: boolean;
}
export interface DeleteFileOperation {
	readonly kind: "delete";
	readonly path: string;
	readonly recursive: boolean;
	readonly ignoreIfNotExists: boolean;
}
export type WorkspaceEditOperation = TextEditOperation | CreateFileOperation | RenameFileOperation | DeleteFileOperation;

export interface ParsedWorkspaceEdit {
	readonly operations: readonly WorkspaceEditOperation[];
}

interface LspLikePosition {
	readonly line: number;
	readonly character: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isLspPosition(value: unknown): value is LspLikePosition {
	return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isLspRange(value: unknown): value is { start: LspLikePosition; end: LspLikePosition } {
	return isRecord(value) && isLspPosition(value.start) && isLspPosition(value.end);
}

/** LSP positions are 0-indexed; Lector's own convention (CodeRange, WorkspaceLocation) is 1-indexed. */
function toOneIndexed(position: LspLikePosition): LspLikePosition {
	return { line: position.line + 1, character: position.character + 1 };
}

function toCodeRange(range: { start: LspLikePosition; end: LspLikePosition }, path: string): CodeRange {
	return { path, start: toOneIndexed(range.start), end: toOneIndexed(range.end) };
}

function fileUriToPath(uri: string): string {
	return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

/** A plain TextEdit may only carry `range`, `newText`, and the spec-legal optional `annotationId` -- anything else (e.g. a vendor snippet-syntax extension) is rejected outright rather than silently applied as plain text. */
function parseTextEdit(raw: unknown): { range: { start: LspLikePosition; end: LspLikePosition }; newText: string } {
	if (!isRecord(raw) || !isLspRange(raw.range) || typeof raw.newText !== "string") {
		throw new UnsupportedWorkspaceEditVariant(`malformed TextEdit: ${JSON.stringify(raw)}`);
	}
	const knownKeys = new Set(["range", "newText", "annotationId"]);
	const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key));
	if (unknownKeys.length > 0) throw new UnsupportedWorkspaceEditVariant(`TextEdit carries unrecognized field(s): ${unknownKeys.join(", ")}`);
	return { range: { start: toOneIndexed(raw.range.start), end: toOneIndexed(raw.range.end) }, newText: raw.newText };
}

function parseTextEdits(raw: unknown): readonly { range: { start: LspLikePosition; end: LspLikePosition }; newText: string }[] {
	if (!Array.isArray(raw)) throw new UnsupportedWorkspaceEditVariant("TextDocumentEdit.edits is not an array");
	return raw.map(parseTextEdit);
}

function parseChangesMap(changes: Record<string, unknown>): TextEditOperation[] {
	return Object.entries(changes).map(([uri, edits]) => ({ kind: "text" as const, path: fileUriToPath(uri), edits: parseTextEdits(edits) }));
}

function parseDocumentChangeEntry(raw: unknown): WorkspaceEditOperation {
	if (!isRecord(raw)) throw new UnsupportedWorkspaceEditVariant(`malformed documentChanges entry: ${JSON.stringify(raw)}`);
	if (raw.kind === "create") {
		const options = isRecord(raw.options) ? raw.options : {};
		if (typeof raw.uri !== "string") throw new UnsupportedWorkspaceEditVariant("CreateFile missing uri");
		return { kind: "create", path: fileUriToPath(raw.uri), overwrite: options.overwrite === true, ignoreIfExists: options.ignoreIfExists === true };
	}
	if (raw.kind === "rename") {
		const options = isRecord(raw.options) ? raw.options : {};
		if (typeof raw.oldUri !== "string" || typeof raw.newUri !== "string") throw new UnsupportedWorkspaceEditVariant("RenameFile missing oldUri/newUri");
		return {
			kind: "rename",
			fromPath: fileUriToPath(raw.oldUri),
			toPath: fileUriToPath(raw.newUri),
			overwrite: options.overwrite === true,
			ignoreIfExists: options.ignoreIfExists === true,
		};
	}
	if (raw.kind === "delete") {
		const options = isRecord(raw.options) ? raw.options : {};
		if (typeof raw.uri !== "string") throw new UnsupportedWorkspaceEditVariant("DeleteFile missing uri");
		return { kind: "delete", path: fileUriToPath(raw.uri), recursive: options.recursive === true, ignoreIfNotExists: options.ignoreIfNotExists === true };
	}
	if (raw.kind !== undefined) throw new UnsupportedWorkspaceEditVariant(`unrecognized resource operation kind: ${JSON.stringify(raw.kind)}`);
	// A plain TextDocumentEdit -- no "kind" discriminant of its own.
	if (!isRecord(raw.textDocument) || typeof raw.textDocument.uri !== "string") {
		throw new UnsupportedWorkspaceEditVariant("TextDocumentEdit missing textDocument.uri");
	}
	if (raw.textDocument.version !== null && typeof raw.textDocument.version !== "number") {
		throw new UnsupportedWorkspaceEditVariant("TextDocumentEdit missing numeric or null textDocument.version");
	}
	return {
		kind: "text",
		path: fileUriToPath(raw.textDocument.uri),
		version: raw.textDocument.version,
		edits: parseTextEdits(raw.edits),
	};
}

/**
 * Parses a textDocument/rename response into an ordered list of operations, per spec preferring
 * `documentChanges` over `changes` when both are present. Any TextEdit variant this client
 * doesn't fully understand (a vendor snippet-syntax extension, an unrecognized resource
 * operation kind) throws UnsupportedWorkspaceEditVariant rather than silently mis-applying it.
 */
export function parseWorkspaceEdit(raw: unknown): ParsedWorkspaceEdit {
	if (!isRecord(raw)) return { operations: [] };
	if (Array.isArray(raw.documentChanges)) return { operations: raw.documentChanges.map(parseDocumentChangeEntry) };
	if (isRecord(raw.changes)) return { operations: parseChangesMap(raw.changes) };
	return { operations: [] };
}
