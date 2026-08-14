export {
	type ApplyPatchRequest,
	applyPatch,
	PatchRejected,
} from "./apply-patch.ts";
export type { AutoPopulationRootClassification, ClassifyAutoPopulationRootInput } from "./classify-auto-population-root.ts";
export { classifyAutoPopulationRoot } from "./classify-auto-population-root.ts";
export type { CodeRange } from "./code-range.ts";
export {
	type EditOutcome,
	type ExpectedHashEdit,
	exactEdit,
	StaleExpectedHash,
} from "./exact-edit.ts";
export type { FileTreeEntry, FileTreeEntryKind, FileTreePort } from "./file-tree-port.ts";
export { WorkspaceEntryAlreadyExists, WorkspaceEntryDoesNotExist } from "./file-tree-port.ts";
export { findWorkspaceSymbols } from "./find-workspace-symbols.ts";
export { InMemoryWorkspace } from "./in-memory-workspace.ts";
export {
	type LineEdit,
	type LineEditFailure,
	type LineEditFailureReason,
	type LineEditInsertAfter,
	type LineEditInsertBefore,
	type LineEditOutcome,
	LineEditRace,
	LineEditRejected,
	type LineEditReplace,
	type LineEditRequest,
	lineEdit,
} from "./line-edit.ts";
export type { DirectoryListing } from "./list-directory.ts";
export { listDirectory } from "./list-directory.ts";
export { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "./local-filesystem-workspace.ts";
export { isFilesystemRoot } from "./nearest-workspace-root.ts";
export type { MissingWorkspaceEntry, PresentWorkspaceEntry, WorkspaceEntry, WorkspacePort } from "./port.ts";
export { raceWorkspaceQuery } from "./race-workspace-query.ts";
export { type RawRead, rawRead, WorkspaceEntryNotFound } from "./raw-read.ts";
export { ReadOnlyWorkspace, WorkspaceIsReadOnly } from "./read-only-workspace.ts";
export type { WorkspaceResolutionFallback, WorkspaceResolutionOutcome, WorkspaceResolutionRequest } from "./resolve-workspace-path.ts";
export type { ConciseProvenance, FormattedSymbol, FormattedSymbolSearchResult, ResponseFormat } from "./response-format.ts";
export { formatProvenanced, formatSymbolSearchResult, toConciseProvenance } from "./response-format.ts";
export { deriveSourceManifest, type SourceManifest, SourceManifestLimitExceeded } from "./source-manifest.ts";
export {
	InvalidUnifiedDiff,
	parseUnifiedDiff,
	type UnifiedDiffHunk,
} from "./unified-diff.ts";
export type { WorkspaceMapEntry, WorkspaceMapOptions, WorkspaceMapResult } from "./workspace-map.ts";
export { computeWorkspaceMap } from "./workspace-map.ts";
export type { WorkspaceQueryOutcome, WorkspaceQueryStatus } from "./workspace-query-outcome.ts";
export type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "./workspace-symbol.ts";
