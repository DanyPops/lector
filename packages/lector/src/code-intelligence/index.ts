export type { SymbolComparisonStatus, SymbolDeclarationComparison } from "./compare-symbol-declarations.ts";
export type { Diagnostic, DiagnosticSeverity } from "./diagnostic.ts";
export { diagnostics } from "./diagnostics.ts";
export type { DocumentSymbolEntry } from "./document-symbol.ts";
export { documentSymbols } from "./document-symbols.ts";
export { type ClosableIntelligenceIndex, FallbackCodeIntelligenceIndex } from "./fallback-code-intelligence-index.ts";
export { findReferences } from "./find-references.ts";
export { goToDefinition } from "./go-to-definition.ts";
export { goToImplementation } from "./go-to-implementation.ts";
export type { Hover } from "./hover.ts";
export { hoverAt } from "./hover-at.ts";
export type {
	IntelligenceFidelity,
	IntelligenceProvenance,
	IntelligenceSourceOutcome,
	ProvenancedResult,
	SymbolSearchBounds,
} from "./intelligence-provenance.ts";
export {
	descriptorForExtension,
	LANGUAGE_SERVER_DESCRIPTORS,
	type LanguageServerDescriptor,
	PYTHON_DESCRIPTOR,
	TYPESCRIPT_DESCRIPTOR,
} from "./language-server-descriptor.ts";
export {
	type CgroupV2DiscoveryOptions,
	type CgroupV2MemoryPaths,
	createLinuxCgroupWarmIndexResourceSnapshot,
	discoverCgroupV2MemoryPaths,
	type LinuxCgroupWarmIndexResourceOptions,
	type ResourceTextFilePort,
} from "./linux-cgroup-warm-index-resources.ts";
export {
	LanguageServerCapacityExceeded,
	LanguageServerProcess,
	LanguageServerProcessExited,
	LanguageServerRequestTimedOut,
} from "./lsp/language-server-process.ts";
export {
	LanguageFileLimitExceeded,
	LanguageFileOutsideWorkspace,
	LanguageServerPositionEncodingUnsupported,
	LanguageServerWorkspaceNotReady,
	LspSymbolIndex,
	type LspSymbolIndexOptions,
} from "./lsp/lsp-symbol-index.ts";
export { PolyglotCodeIntelligenceIndex, type PolyglotIndexEntry } from "./polyglot-code-intelligence-index.ts";
export type { CodeIntelligencePort } from "./port.ts";
export type { SymbolDeclarationSnapshot } from "./symbol-declaration-snapshot.ts";
export type { SymbolIndexPort } from "./symbol-index-port.ts";
export { assertBoundedSymbolQuery, InvalidSymbolQuery, MAX_SYMBOL_QUERY_BYTES } from "./symbol-query.ts";
export { TreeSitterSymbolIndex, type TreeSitterSymbolIndexOptions } from "./tree-sitter/typescript-tree-sitter-symbol-index.ts";
export { TypeScriptCompilerSymbolIndex, type TypeScriptCompilerSymbolIndexOptions } from "./typescript-compiler-symbol-index.ts";
export {
	AdaptiveWarmIndexResourcePolicy,
	type AdaptiveWarmIndexResourcePolicyOptions,
	type WarmIndexAdmissionPolicy,
	type WarmIndexResourcePolicy,
	type WarmIndexResourcePressure,
	type WarmIndexResourceSnapshot,
	type WarmIndexResourceSnapshotPort,
	type WarmIndexResourceStatus,
	type WarmIndexResourceStatusProvider,
	type WarmIndexRetentionPolicy,
} from "./warm-index-resource-policy.ts";
