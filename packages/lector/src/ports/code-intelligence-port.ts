import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../domain/call-hierarchy.ts";
import type { Diagnostic } from "../domain/diagnostic.ts";
import type { DocumentSymbolEntry } from "../domain/document-symbol.ts";
import type { Hover } from "../domain/hover.ts";
import type { WorkspaceLocation } from "../domain/workspace-symbol.ts";

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
	/** Where the symbol at `at` is actually declared -- may cross files, may return more than one candidate. */
	goToDefinition(at: WorkspaceLocation): Promise<WorkspaceLocation[]>;
	/** Every concrete implementation of the interface/abstract member at `at` -- unlike goToDefinition, crosses a port/interface boundary into its real adapters. */
	goToImplementation(at: WorkspaceLocation): Promise<WorkspaceLocation[]>;
	/** Every project-wide usage of the symbol at `at`. */
	findReferences(at: WorkspaceLocation, includeDeclaration: boolean): Promise<WorkspaceLocation[]>;
	/** Type/doc information for the symbol at `at`, or undefined when the server has none. */
	hover(at: WorkspaceLocation): Promise<Hover | undefined>;
	/** Every symbol declared in one file, hierarchically. */
	documentSymbols(path: string): Promise<DocumentSymbolEntry[]>;
	/** Every diagnostic currently known for one file, as of the server's last analysis (push-based, not a live re-check). */
	diagnostics(path: string): Promise<Diagnostic[]>;
	/** The call-hierarchy root(s) the symbol at `at` resolves to -- usually zero or one. */
	prepareCallHierarchy(at: WorkspaceLocation): Promise<CallHierarchyEntry[]>;
	/** Every real caller of the symbol at `at`, project-wide. */
	incomingCalls(at: WorkspaceLocation): Promise<IncomingCall[]>;
	/** Every function/method the symbol at `at` itself calls. */
	outgoingCalls(at: WorkspaceLocation): Promise<OutgoingCall[]>;
}
