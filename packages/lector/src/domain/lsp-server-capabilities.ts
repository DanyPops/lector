/** Position encoding a server negotiated for line/character offsets. LSP defaults to utf-16 when omitted. */
export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

export type TextDocumentSyncKind = "none" | "full" | "incremental";

export interface WorkspaceFileOperationCapabilities {
	readonly willRename: boolean;
	readonly didRename: boolean;
	readonly willDelete: boolean;
	readonly didDelete: boolean;
	readonly willCreate: boolean;
	readonly didCreate: boolean;
}

export interface DiagnosticProviderCapabilities {
	readonly interFileDependencies: boolean;
	readonly workspaceDiagnostics: boolean;
}

export interface ParsedServerCapabilities {
	readonly positionEncoding: PositionEncoding;
	readonly textDocumentSyncKind: TextDocumentSyncKind;
	readonly renameProvider: boolean;
	readonly prepareRenameProvider: boolean;
	readonly workspaceFileOperations: WorkspaceFileOperationCapabilities;
	readonly workDoneProgress: boolean;
	/** undefined means the server never declared pull-model diagnostics at all -- distinct from declaring it with both flags false. */
	readonly diagnosticProvider: DiagnosticProviderCapabilities | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Parses the subset of `initialize`'s response `capabilities` object Lector
 * actually acts on. Every field defaults to "not supported" rather than
 * throwing when absent -- the LSP spec explicitly allows a server to omit
 * most capabilities, which means "unsupported", not "malformed response".
 */
export function parseServerCapabilities(raw: unknown): ParsedServerCapabilities {
	const capabilities = isRecord(raw) ? raw : {};

	const positionEncodingValue = capabilities.positionEncoding;
	const positionEncoding: PositionEncoding = positionEncodingValue === "utf-8" || positionEncodingValue === "utf-32" ? positionEncodingValue : "utf-16";

	const textDocumentSyncKind = parseTextDocumentSyncKind(capabilities.textDocumentSync);

	const renameProviderValue = capabilities.renameProvider;
	const renameProvider = renameProviderValue === true || isRecord(renameProviderValue);
	const prepareRenameProvider = isRecord(renameProviderValue) && renameProviderValue.prepareProvider === true;

	const workspace = isRecord(capabilities.workspace) ? capabilities.workspace : {};
	const fileOperations = isRecord(workspace.fileOperations) ? workspace.fileOperations : {};
	const workspaceFileOperations: WorkspaceFileOperationCapabilities = {
		willRename: fileOperations.willRename !== undefined,
		didRename: fileOperations.didRename !== undefined,
		willDelete: fileOperations.willDelete !== undefined,
		didDelete: fileOperations.didDelete !== undefined,
		willCreate: fileOperations.willCreate !== undefined,
		didCreate: fileOperations.didCreate !== undefined,
	};

	const windowCapabilities = isRecord(capabilities.window) ? capabilities.window : {};
	const workDoneProgress = windowCapabilities.workDoneProgress === true;

	const diagnosticProviderValue = capabilities.diagnosticProvider;
	const diagnosticProvider: DiagnosticProviderCapabilities | undefined = isRecord(diagnosticProviderValue)
		? {
				interFileDependencies: diagnosticProviderValue.interFileDependencies === true,
				workspaceDiagnostics: diagnosticProviderValue.workspaceDiagnostics === true,
			}
		: undefined;

	return { positionEncoding, textDocumentSyncKind, renameProvider, prepareRenameProvider, workspaceFileOperations, workDoneProgress, diagnosticProvider };
}

function parseTextDocumentSyncKind(value: unknown): TextDocumentSyncKind {
	const kind = isRecord(value) ? value.change : value;
	if (kind === 1) return "full";
	if (kind === 2) return "incremental";
	return "none";
}
