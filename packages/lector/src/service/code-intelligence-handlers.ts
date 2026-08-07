import { diagnostics as diagnosticsQuery } from "../code-intelligence/diagnostics.ts";
import { documentSymbols as documentSymbolsQuery } from "../code-intelligence/document-symbols.ts";
import { findReferences as findReferencesQuery } from "../code-intelligence/find-references.ts";
import { goToDefinition as goToDefinitionQuery } from "../code-intelligence/go-to-definition.ts";
import { goToImplementation as goToImplementationQuery } from "../code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../code-intelligence/hover-at.ts";
import type { LanguageServerDescriptor } from "../code-intelligence/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import { assertBoundedSymbolQuery } from "../code-intelligence/symbol-query.ts";
import {
	CodeIntelligenceUnavailable,
	MAX_SYMBOL_RESULTS,
	type MutableRegistry,
	type OperationInputs,
	type OperationOutputs,
	UnknownWorkspace,
	type WorkspaceId,
} from "../service.ts";
import { incomingCalls as incomingCallsQuery } from "../symbol-graph/incoming-calls.ts";
import { outgoingCalls as outgoingCallsQuery } from "../symbol-graph/outgoing-calls.ts";
import { prepareCallHierarchy as prepareCallHierarchyQuery } from "../symbol-graph/prepare-call-hierarchy.ts";
import { findWorkspaceSymbols } from "../workspace/find-workspace-symbols.ts";
import { formatProvenanced, formatSymbolSearchResult } from "../workspace/response-format.ts";
import { supportsCodeIntelligence, type WarmIndexRegistry } from "./warm-index-registry.ts";

export interface CodeIntelligenceHandlerDeps {
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
}

export interface CodeIntelligenceHandlers {
	"workspace.findSymbols": (registry: MutableRegistry, input: OperationInputs["workspace.findSymbols"]) => Promise<OperationOutputs["workspace.findSymbols"]>;
	"workspace.goToDefinition": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.goToDefinition"],
	) => Promise<OperationOutputs["workspace.goToDefinition"]>;
	"workspace.goToImplementation": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.goToImplementation"],
	) => Promise<OperationOutputs["workspace.goToImplementation"]>;
	"workspace.findReferences": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.findReferences"],
	) => Promise<OperationOutputs["workspace.findReferences"]>;
	"workspace.hover": (registry: MutableRegistry, input: OperationInputs["workspace.hover"]) => Promise<OperationOutputs["workspace.hover"]>;
	"workspace.documentSymbols": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.documentSymbols"],
	) => Promise<OperationOutputs["workspace.documentSymbols"]>;
	"workspace.diagnostics": (registry: MutableRegistry, input: OperationInputs["workspace.diagnostics"]) => Promise<OperationOutputs["workspace.diagnostics"]>;
	"workspace.prepareCallHierarchy": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.prepareCallHierarchy"],
	) => Promise<OperationOutputs["workspace.prepareCallHierarchy"]>;
	"workspace.incomingCalls": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.incomingCalls"],
	) => Promise<OperationOutputs["workspace.incomingCalls"]>;
	"workspace.outgoingCalls": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.outgoingCalls"],
	) => Promise<OperationOutputs["workspace.outgoingCalls"]>;
	"workspace.hasWarmIndex": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.hasWarmIndex"],
	) => Promise<OperationOutputs["workspace.hasWarmIndex"]>;
}

/**
 * The Tier A code-intelligence operations (findSymbols, goToDefinition, findReferences, hover,
 * documentSymbols, diagnostics, callHierarchy) plus hasWarmIndex -- every operation whose only
 * real dependency is a warm SymbolIndexPort. Deliberately excludes populateSymbolGraph/
 * cacheStatus/rename/referenceBasedRename: those also touch GraphRefreshCoordinator,
 * RepoFetcherPort and WorkspaceWatchHandlers, a genuinely different (and more entangled)
 * concern -- see service/symbol-graph-handlers.ts.
 */
/**
 * Shared by both this module's own Tier A handlers and service/symbol-graph-handlers.ts's
 * rename/referenceBasedRename cluster (both need "a warm index that actually supports
 * code-intelligence for this position"), so it's exported standalone rather than trapped in
 * createCodeIntelligenceHandlers' own closure.
 */
export async function requireCodeIntelligence(
	warmIndexes: WarmIndexRegistry<WorkspaceId>,
	input: { workspaceId: WorkspaceId; path?: string; seedFile?: string },
): Promise<{ index: SymbolIndexPort & CodeIntelligencePort; descriptor: LanguageServerDescriptor }> {
	const { index, descriptor } = warmIndexes.ensureWarmIndex(input);
	if (!supportsCodeIntelligence(index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
	return { index, descriptor };
}

export function createCodeIntelligenceHandlers(deps: CodeIntelligenceHandlerDeps): CodeIntelligenceHandlers {
	const { warmIndexes } = deps;

	return {
		async "workspace.findSymbols"(_registry, input) {
			assertBoundedSymbolQuery(input.query);
			const maxResults = input.maxResults ?? 1_000;
			if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SYMBOL_RESULTS) {
				throw new TypeError(`maxResults must be a positive safe integer no greater than ${MAX_SYMBOL_RESULTS}`);
			}
			const { index } = warmIndexes.ensureWorkspaceIndex(input.workspaceId, input.seedFile);
			const result = await findWorkspaceSymbols(index, input.query, { maxResults });
			// "concise" narrows the actual JSON payload per workspace/response-format.ts; the declared
			// output type stays SymbolSearchResult (this operation's default, and every untouched
			// caller's honest shape) -- a caller that opts into responseFormat:"concise" already knows
			// to treat fields absent from the concise contract as absent, not to trust this type for it.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see comment above
			return formatSymbolSearchResult(result, input.responseFormat ?? "detailed") as OperationOutputs["workspace.findSymbols"];
		},
		async "workspace.goToDefinition"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const locations = await goToDefinitionQuery(index, { path: input.path, line: input.line, character: input.character });
			return { locations, provenance: index.provenance };
		},
		async "workspace.goToImplementation"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const locations = await goToImplementationQuery(index, { path: input.path, line: input.line, character: input.character });
			return { locations, provenance: index.provenance };
		},
		async "workspace.findReferences"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const locations = await findReferencesQuery(index, { path: input.path, line: input.line, character: input.character }, input.includeDeclaration);
			// See workspace.findSymbols' identical note on the concise/detailed type-vs-runtime tradeoff.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return formatProvenanced({ locations, provenance: index.provenance }, input.responseFormat ?? "detailed") as OperationOutputs["workspace.findReferences"];
		},
		async "workspace.hover"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const hover = await hoverAt(index, { path: input.path, line: input.line, character: input.character });
			return { hover, provenance: index.provenance };
		},
		async "workspace.documentSymbols"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const symbols = await documentSymbolsQuery(index, input.path);
			return { symbols, provenance: index.provenance };
		},
		async "workspace.diagnostics"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const diagnostics = await diagnosticsQuery(index, input.path);
			return { diagnostics, provenance: index.provenance };
		},
		async "workspace.prepareCallHierarchy"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const items = await prepareCallHierarchyQuery(index, { path: input.path, line: input.line, character: input.character });
			return { items, provenance: index.provenance };
		},
		async "workspace.incomingCalls"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const calls = await incomingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
			return { calls, provenance: index.provenance };
		},
		async "workspace.outgoingCalls"(_registry, input) {
			const { index } = await requireCodeIntelligence(warmIndexes, input);
			const calls = await outgoingCallsQuery(index, { path: input.path, line: input.line, character: input.character });
			return { calls, provenance: index.provenance };
		},
		// Never spawns -- a caller deciding whether to enrich a result with LSP-backed info must not
		// pay a cold-start cost just to check. With a path, checks that file's own language; without
		// one, whether anything is warm for the workspace at all.
		async "workspace.hasWarmIndex"(registry, input) {
			const entry = registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			return { warm: warmIndexes.hasWarmIndex(input.workspaceId, input.path) };
		},
	};
}
