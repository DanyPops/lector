export { InMemoryContentCache } from "./adapters/in-memory-content-cache.ts";
export { InMemorySymbolGraph } from "./adapters/in-memory-symbol-graph.ts";
export { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
export { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "./adapters/local-filesystem-workspace.ts";
export {
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestTimedOut,
} from "./adapters/lsp/language-server-process.ts";
export { LspSymbolIndex } from "./adapters/lsp/lsp-symbol-index.ts";
export { SqliteContentCache } from "./adapters/sqlite-content-cache.ts";
export { SqliteSymbolGraph } from "./adapters/sqlite-symbol-graph.ts";
export { TreeSitterSymbolIndex } from "./adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
export {
	type ConnectLectorClientOptions,
	connectLectorClient,
	connectLectorClientAt,
	type LectorClient,
	remoteErrorIs,
} from "./client.ts";
export { resolveLectorPaths } from "./constants.ts";
export { buildLectorApp, type LectorDaemonOptions, serveMain, startLectorDaemon } from "./daemon.ts";
export type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "./domain/call-hierarchy.ts";
export type { CodeRange } from "./domain/code-range.ts";
export { type ContentHash, contentHashOf } from "./domain/content-hash.ts";
export type { Diagnostic, DiagnosticSeverity } from "./domain/diagnostic.ts";
export { diagnostics } from "./domain/diagnostics.ts";
export type { DocumentSymbolEntry } from "./domain/document-symbol.ts";
export { documentSymbols } from "./domain/document-symbols.ts";
export {
	type EditOutcome,
	type ExpectedHashEdit,
	exactEdit,
	StaleExpectedHash,
} from "./domain/exact-edit.ts";
export { findReferences } from "./domain/find-references.ts";
export { findWorkspaceSymbols } from "./domain/find-workspace-symbols.ts";
export { goToDefinition } from "./domain/go-to-definition.ts";
export type { Hover } from "./domain/hover.ts";
export { hoverAt } from "./domain/hover-at.ts";
export { incomingCalls } from "./domain/incoming-calls.ts";
export {
	descriptorForExtension,
	LANGUAGE_SERVER_DESCRIPTORS,
	type LanguageServerDescriptor,
	PYTHON_DESCRIPTOR,
	TYPESCRIPT_DESCRIPTOR,
} from "./domain/language-server-descriptor.ts";
export { outgoingCalls } from "./domain/outgoing-calls.ts";
export { type PopulateSymbolGraphResult, populateSymbolGraph } from "./domain/populate-symbol-graph.ts";
export { prepareCallHierarchy } from "./domain/prepare-call-hierarchy.ts";
export { type RawRead, rawRead, WorkspaceEntryNotFound } from "./domain/raw-read.ts";
export { reachableSymbolsFrom } from "./domain/reachable-symbols-from.ts";
export { symbolEdgesFrom } from "./domain/symbol-edges-from.ts";
export { symbolEdgesTo } from "./domain/symbol-edges-to.ts";
export { deriveSymbolNodeId, type SymbolNodeId } from "./domain/symbol-node-id.ts";
export type { WorkspaceLocation, WorkspaceSymbol } from "./domain/workspace-symbol.ts";
export type { CodeIntelligencePort } from "./ports/code-intelligence-port.ts";
export type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "./ports/content-cache-port.ts";
export type { SymbolEdgeKind, SymbolGraphPort, SymbolNode } from "./ports/symbol-graph-port.ts";
export type { SymbolIndexPort } from "./ports/symbol-index-port.ts";
export type { MissingWorkspaceEntry, PresentWorkspaceEntry, WorkspaceEntry, WorkspacePort } from "./ports/workspace-port.ts";
export {
	type ClosableSymbolIndex,
	CodeIntelligenceUnavailable,
	createLectorService,
	InvalidWorkspaceRoot,
	type LectorService,
	type LectorServiceOptions,
	OPERATION_NAMES,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	SymbolQueryUnavailable,
	UnknownWorkspace,
	type WorkspaceId,
} from "./service.ts";
export { lectorVersion } from "./version.ts";
