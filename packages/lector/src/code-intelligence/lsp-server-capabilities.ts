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
	/** The identifier a pull request must echo back (DocumentDiagnosticParams.identifier) when a server distinguishes several diagnostic sources for the same document -- undefined when the server never declared one, matching a plain unlabeled pull. */
	readonly identifier: string | undefined;
}

export interface ParsedServerCapabilities {
	readonly positionEncoding: PositionEncoding;
	readonly textDocumentSyncKind: TextDocumentSyncKind;
	readonly renameProvider: boolean;
	readonly prepareRenameProvider: boolean;
	readonly documentHighlightProvider: boolean;
	readonly workspaceFileOperations: WorkspaceFileOperationCapabilities;
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

	const documentHighlightProviderValue = capabilities.documentHighlightProvider;
	const documentHighlightProvider = documentHighlightProviderValue === true || isRecord(documentHighlightProviderValue);

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

	// Deliberately no top-level "workDoneProgress" field here: ServerCapabilities has no such
	// property in the LSP spec (verified against the 3.17 specification directly, not assumed --
	// `window.workDoneProgress` is a *client* capability declaring "I can handle a server asking
	// me to create a progress token", not something a server reports back). Progress support is
	// instead declared per-feature via each provider's own optional WorkDoneProgressOptions.
	const diagnosticProviderValue = capabilities.diagnosticProvider;
	const diagnosticProvider: DiagnosticProviderCapabilities | undefined = isRecord(diagnosticProviderValue)
		? {
				interFileDependencies: diagnosticProviderValue.interFileDependencies === true,
				workspaceDiagnostics: diagnosticProviderValue.workspaceDiagnostics === true,
				identifier: typeof diagnosticProviderValue.identifier === "string" ? diagnosticProviderValue.identifier : undefined,
			}
		: undefined;

	return {
		positionEncoding,
		textDocumentSyncKind,
		renameProvider,
		prepareRenameProvider,
		documentHighlightProvider,
		workspaceFileOperations,
		diagnosticProvider,
	};
}

function parseTextDocumentSyncKind(value: unknown): TextDocumentSyncKind {
	const kind = isRecord(value) ? value.change : value;
	if (kind === 1) return "full";
	if (kind === 2) return "incremental";
	return "none";
}

/**
 * Whether didOpen/didChange/didClose should actually be sent to a server that negotiated
 * `syncKind`. Per the LSP 3.17 spec ("textDocumentSync ... If omitted it defaults to
 * TextDocumentSyncKind.None", confirmed directly against the spec, not assumed), a server that
 * never declares (or explicitly declares None) document sync has told the client it does not
 * track document content via these notifications -- sending them anyway is not itself unsafe,
 * but is pure wasted traffic the server will ignore. "incremental" is treated the same as
 * "full" here: this client only ever sends Full-content changes (a deliberately deferred
 * optimization -- see ensureFileOpen's own doc comment), and a Full contentChange is spec-legal
 * regardless of which kind a server asked for.
 */
export function shouldSyncDocuments(syncKind: TextDocumentSyncKind): boolean {
	return syncKind !== "none";
}
