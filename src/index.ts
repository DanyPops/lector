export { contentHashOf, type ContentHash } from "./domain/content-hash.ts";
export { rawRead, WorkspaceEntryNotFound, type RawRead } from "./domain/raw-read.ts";
export {
	exactEdit,
	StaleExpectedHash,
	type EditOutcome,
	type ExpectedHashEdit,
} from "./domain/exact-edit.ts";
export type { MissingWorkspaceEntry, PresentWorkspaceEntry, WorkspaceEntry, WorkspacePort } from "./ports/workspace-port.ts";
export { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
export { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "./adapters/local-filesystem-workspace.ts";
export { findWorkspaceSymbols } from "./domain/find-workspace-symbols.ts";
export type { WorkspaceLocation, WorkspaceSymbol } from "./domain/workspace-symbol.ts";
export type { SymbolIndexPort } from "./ports/symbol-index-port.ts";
export type { ContentCacheEntry, ContentCachePort, ContentSymbol } from "./ports/content-cache-port.ts";
export { InMemoryContentCache } from "./adapters/in-memory-content-cache.ts";
export { SqliteContentCache } from "./adapters/sqlite-content-cache.ts";
export { TypescriptSymbolIndex } from "./adapters/lsp/typescript-symbol-index.ts";
export { TreeSitterSymbolIndex } from "./adapters/tree-sitter/typescript-tree-sitter-symbol-index.ts";
export {
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestTimedOut,
} from "./adapters/lsp/language-server-process.ts";
export {
	createLectorService,
	InvalidWorkspaceRoot,
	OPERATION_NAMES,
	SymbolQueryUnavailable,
	UnknownWorkspace,
	type ClosableSymbolIndex,
	type LectorService,
	type LectorServiceOptions,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	type WorkspaceId,
} from "./service.ts";
export { buildLectorApp, serveMain, startLectorDaemon, type LectorDaemonOptions } from "./daemon.ts";
export { resolveLectorPaths } from "./constants.ts";
export {
	connectLectorClient,
	connectLectorClientAt,
	remoteErrorIs,
	type ConnectLectorClientOptions,
	type LectorClient,
} from "./client.ts";
export { lectorVersion } from "./version.ts";
