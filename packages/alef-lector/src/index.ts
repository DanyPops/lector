// Narrow on purpose: these four classes' public types never reference @danypops/lector's
// own raw source, so a consumer's tsc never has to resolve it through this barrel.
export { LectorCallGraphPort, type PopulateSymbolGraphResult, type SymbolEdgeKind, type SymbolNode } from "./call-graph-port.js";
export {
	type CallHierarchyEntry,
	type CodeRange,
	type Diagnostic,
	type DiagnosticSeverity,
	type DocumentSymbolEntry,
	type Hover,
	type IncomingCall,
	LectorCodeIntelligencePort,
	type OutgoingCall,
	type WorkspaceLocation,
	type WorkspacePosition,
} from "./code-intelligence-port.js";
export {
	LectorFilesystemPort,
	type MissingWorkspaceEntry,
	type PresentWorkspaceEntry,
	StaleWorkspaceWrite,
	type WorkspaceEntry,
	type WorkspaceWriteResult,
} from "./filesystem-port.js";
export {
	type GitDiffResult,
	type GitLogEntry,
	type GitStatusEntry,
	type GitStatusSummary,
	LectorGitPort,
} from "./git-port.js";
