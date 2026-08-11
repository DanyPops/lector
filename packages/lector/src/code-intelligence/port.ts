import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../symbol-graph/call-hierarchy.ts";
import type { ParsedWorkspaceEdit, RenameRange } from "../workspace/workspace-edit.ts";
import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { DocumentHighlight } from "./document-highlight.ts";
import type { DocumentSymbolEntry } from "./document-symbol.ts";
import type { Hover } from "./hover.ts";
import type { IntelligenceProvenance } from "./intelligence-provenance.ts";

/**
 * CodeIntelligencePort -- the role a driven adapter plays for the semantic,
 * position-based queries a real language server (not a syntax-only parser)
 * can honestly answer: where is this actually defined (across files, through
 * re-exports and aliasing), what does this resolve to, what's its type/doc,
 * what's declared in this file. Deliberately separate from SymbolIndexPort
 * (findSymbols, a fuzzy name search both an LSP and a tree-sitter backend
 * can serve): tree-sitter has no type system and cannot honestly resolve
 * cross-file references or hover types, so it does not implement this port
 * at all rather than faking a degraded answer. Backed by the same warm LSP
 * process findSymbols already keeps alive per workspace -- not a second one.
 */
export interface CodeIntelligencePort {
	readonly provenance?: IntelligenceProvenance;
	provenanceForPath?(path: string): IntelligenceProvenance | undefined;
	/** Where the symbol at `at` is actually declared -- may cross files, may return more than one candidate. */
	goToDefinition(at: WorkspaceLocation): Promise<WorkspaceLocation[]>;
	/** Every concrete implementation of the interface/abstract member at `at` -- unlike goToDefinition, crosses a port/interface boundary into its real adapters. */
	goToImplementation(at: WorkspaceLocation): Promise<WorkspaceLocation[]>;
	/** Every project-wide usage of the symbol at `at`. */
	findReferences(at: WorkspaceLocation, includeDeclaration: boolean): Promise<WorkspaceLocation[]>;
	/** Optional: only implemented by a backend that can honestly answer LSP's textDocument/documentHighlight (an LSP-backed index always implements this method regardless of what the negotiated server itself declared -- an unsupporting server's own null/error response degrades to an empty list, matching prepareRename's identical pattern; a tree-sitter/compiler-API fallback with no such request to make simply omits the method). Every other same-symbol occurrence within the single already-open document containing `at`, classified read/write/text -- see DocumentHighlight's own doc comment for why this is scoped to one document rather than merged into findReferences. */
	documentHighlights?(at: WorkspaceLocation): Promise<DocumentHighlight[]>;
	/** Type/doc information for the symbol at `at`, or undefined when the server has none. */
	hover(at: WorkspaceLocation): Promise<Hover | undefined>;
	/**
	 * Every symbol declared in one file, hierarchically.
	 *
	 * `options.settleMs`, when given, overrides this backend's own default post-open
	 * settle wait for this call only -- an internal capability, never exposed through
	 * the daemon's public operation surface. Only populateSymbolGraph's own bulk crawl
	 * uses it today, with a value validated empirically for that specific call
	 * pattern; do not assume it's safe to pass a reduced value from anywhere else
	 * without repeating that validation (see LspSymbolIndex.ensureFileOpen's own
	 * doc comment for what specifically was and wasn't proven safe).
	 */
	documentSymbols(path: string, options?: { settleMs?: number }): Promise<DocumentSymbolEntry[]>;
	/** Every diagnostic currently known for one file, as of the server's last analysis (push-based, not a live re-check). */
	diagnostics(path: string): Promise<Diagnostic[]>;
	/** The call-hierarchy root(s) the symbol at `at` resolves to -- usually zero or one. */
	prepareCallHierarchy(at: WorkspaceLocation): Promise<CallHierarchyEntry[]>;
	/** Every real caller of the symbol at `at`, project-wide. */
	incomingCalls(at: WorkspaceLocation): Promise<IncomingCall[]>;
	/** Every function/method the symbol at `at` itself calls. See documentSymbols's doc comment for `options.settleMs`. */
	outgoingCalls(at: WorkspaceLocation, options?: { settleMs?: number }): Promise<OutgoingCall[]>;
	/**
	 * Optional hint that the caller is done with `path` for now -- a backend
	 * that keeps a bounded number of documents open (e.g. an LSP process) may
	 * free that file's slot; a backend with no such concept (compiler,
	 * tree-sitter) simply doesn't implement this. A later call against the
	 * same path still works correctly -- it just re-opens transparently,
	 * at the normal cost of a cold file. Meant for a bulk one-shot crawl
	 * (populateSymbolGraph) that has no reason to hold every file open at
	 * once, not for a live caller genuinely juggling several files together.
	 */
	releaseFile?(path: string): Promise<void>;
	/**
	 * Optional hint that a real filesystem change happened -- a backend backed by a live LSP
	 * session may forward it to the server as workspace/didChangeWatchedFiles if the server
	 * dynamically registered interest in a matching pattern; a backend with no such concept
	 * (compiler, tree-sitter) simply doesn't implement this. Never spawns a cold backend just to
	 * deliver a notification nothing warm is listening for.
	 */
	notifyFileChanged?(event: FileChangeEvent): void;
	/** Optional: only a server that negotiated prepareRenameProvider implements this. Where/what could be renamed at `at`, or null if a rename is not valid there. */
	prepareRename?(at: WorkspaceLocation): Promise<RenameRange | null>;
	/** Optional: only a server that negotiated renameProvider implements this. The full set of changes needed to rename the symbol at `at` to `newName` -- not yet applied. */
	rename?(at: WorkspaceLocation, newName: string): Promise<ParsedWorkspaceEdit>;
	/** Optional: workspace/willRenameFiles participation for a rename's own RenameFile resource operations, sent before applying anything. A no-op when the negotiated server doesn't support it. */
	notifyFilesWillRename?(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): Promise<void>;
	/** Optional: workspace/didRenameFiles participation, sent only after the rename has committed. A no-op when the negotiated server doesn't support it. */
	notifyFilesDidRename?(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): void;
	notifyFilesWillCreate?(paths: readonly string[]): Promise<void>;
	notifyFilesDidCreate?(paths: readonly string[]): void;
	notifyFilesWillDelete?(paths: readonly string[]): Promise<void>;
	notifyFilesDidDelete?(paths: readonly string[]): void;
}
