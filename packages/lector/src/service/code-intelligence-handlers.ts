import { boundListFromStart, jsonByteSize } from "../bounds/bound-list.ts";
import { truncateUtf8 } from "../bounds/truncate-utf8.ts";
import { diagnostics as diagnosticsQuery } from "../code-intelligence/diagnostics.ts";
import { documentHighlights as documentHighlightsQuery } from "../code-intelligence/document-highlights.ts";
import { documentSymbols as documentSymbolsQuery } from "../code-intelligence/document-symbols.ts";
import { findReferences as findReferencesQuery } from "../code-intelligence/find-references.ts";
import { goToDefinition as goToDefinitionQuery } from "../code-intelligence/go-to-definition.ts";
import { goToImplementation as goToImplementationQuery } from "../code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../code-intelligence/hover-at.ts";
import type { LanguageServerDescriptor } from "../code-intelligence/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import { assertBoundedSymbolQuery } from "../code-intelligence/symbol-query.ts";
import { prepareTypeHierarchy, subtypes, supertypes } from "../code-intelligence/type-hierarchy.ts";
import { incomingCalls as incomingCallsQuery } from "../symbol-graph/incoming-calls.ts";
import { outgoingCalls as outgoingCallsQuery } from "../symbol-graph/outgoing-calls.ts";
import { prepareCallHierarchy as prepareCallHierarchyQuery } from "../symbol-graph/prepare-call-hierarchy.ts";
import { findWorkspaceSymbols } from "../workspace/find-workspace-symbols.ts";
import { normalizeSymbolSearchResult } from "../workspace/normalize-symbol-search-result.ts";
import { formatProvenanced, formatSymbolSearchResult } from "../workspace/response-format.ts";
import {
	DEFAULT_DIAGNOSTIC_BYTES,
	DEFAULT_DIAGNOSTIC_RESULTS,
	DEFAULT_DOCUMENT_SYMBOL_BYTES,
	DEFAULT_DOCUMENT_SYMBOL_RESULTS,
	DEFAULT_HOVER_BYTES,
	DEFAULT_LOCATION_BYTES,
	DEFAULT_LOCATION_RESULTS,
	MAX_DIAGNOSTIC_BYTES,
	MAX_DIAGNOSTIC_RESULTS,
	MAX_DOCUMENT_SYMBOL_BYTES,
	MAX_DOCUMENT_SYMBOL_RESULTS,
	MAX_HOVER_BYTES,
	MAX_LOCATION_BYTES,
	MAX_LOCATION_RESULTS,
	MAX_SYMBOL_RESULTS,
	resolveBound,
	SYMBOL_SEARCH_OVERFETCH_MULTIPLIER,
} from "./bounds.ts";
import { CodeIntelligenceUnavailable, DocumentHighlightsNotSupported, UnknownWorkspace, type WorkspaceId } from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { supportsCodeIntelligence, type WarmIndexLease, type WarmIndexRegistry } from "./warm-index-registry.ts";
import type { MutableRegistry } from "./workspace-registry.ts";

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
	"workspace.documentHighlights": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.documentHighlights"],
	) => Promise<OperationOutputs["workspace.documentHighlights"]>;
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
	"workspace.prepareTypeHierarchy": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.prepareTypeHierarchy"],
	) => Promise<OperationOutputs["workspace.prepareTypeHierarchy"]>;
	"workspace.supertypes": (registry: MutableRegistry, input: OperationInputs["workspace.supertypes"]) => Promise<OperationOutputs["workspace.supertypes"]>;
	"workspace.subtypes": (registry: MutableRegistry, input: OperationInputs["workspace.subtypes"]) => Promise<OperationOutputs["workspace.subtypes"]>;
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
): Promise<WarmIndexLease<{ index: SymbolIndexPort & CodeIntelligencePort; descriptor: LanguageServerDescriptor }>> {
	const lease = await warmIndexes.leaseWarmIndex(input);
	const { index, descriptor } = lease.value;
	if (!supportsCodeIntelligence(index)) {
		await lease[Symbol.asyncDispose]();
		throw new CodeIntelligenceUnavailable(input.workspaceId);
	}
	return { value: { index, descriptor }, [Symbol.asyncDispose]: () => lease[Symbol.asyncDispose]() };
}

const DEFAULT_TYPE_HIERARCHY_DEADLINE_MS = 10_000;
const MAX_TYPE_HIERARCHY_DEADLINE_MS = 120_000;

async function withTypeHierarchyDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new DOMException(`Type hierarchy deadline exceeded after ${deadlineMs}ms`, "TimeoutError")), deadlineMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function createCodeIntelligenceHandlers(deps: CodeIntelligenceHandlerDeps): CodeIntelligenceHandlers {
	const { warmIndexes } = deps;

	return {
		async "workspace.findSymbols"(registry, input) {
			assertBoundedSymbolQuery(input.query);
			const maxResults = input.maxResults ?? 1_000;
			if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SYMBOL_RESULTS) {
				throw new TypeError(`maxResults must be a positive safe integer no greater than ${MAX_SYMBOL_RESULTS}`);
			}
			await using lease = await warmIndexes.leaseWorkspaceIndex(input.workspaceId, input.seedFile);
			// leaseWorkspaceIndex above already required registry.get(input.workspaceId).rootPath to
			// resolve (it throws SymbolQueryUnavailable otherwise) -- this read can't observe it missing.
			const entry = registry.get(input.workspaceId);
			if (!entry?.rootPath) throw new UnknownWorkspace(input.workspaceId);
			const overfetchBound = Math.min(maxResults * SYMBOL_SEARCH_OVERFETCH_MULTIPLIER, MAX_SYMBOL_RESULTS);
			// find_symbols' own documented contract is case-insensitive; sending the caller's original
			// casing straight to the backend leaks each backend's own case-sensitive ranking into what
			// SHOULD be a case-neutral match -- live evidence: rust-analyzer's workspace/symbol never
			// surfaced a real "normalize" symbol at all for the query "Normalize", so no amount of
			// post-filtering here could have recovered it. Lowercasing the outbound query (matching the
			// exact casing normalizeSymbolSearchResult's own needle already normalizes to) maximizes a
			// case-sensitive backend's own recall without changing what counts as a match.
			const raw = await findWorkspaceSymbols(lease.value.index, input.query.toLowerCase(), { maxResults: overfetchBound });
			const result = normalizeSymbolSearchResult(raw, input.query, entry.rootPath, maxResults);
			// "concise" narrows the actual JSON payload per workspace/response-format.ts; the declared
			// output type stays SymbolSearchResult (this operation's default, and every untouched
			// caller's honest shape) -- a caller that opts into responseFormat:"concise" already knows
			// to treat fields absent from the concise contract as absent, not to trust this type for it.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see comment above
			return formatSymbolSearchResult(result, input.responseFormat ?? "detailed") as OperationOutputs["workspace.findSymbols"];
		},
		async "workspace.goToDefinition"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const locations = await goToDefinitionQuery(lease.value.index, { path: input.path, line: input.line, character: input.character });
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(locations, maxResults, maxBytes, jsonByteSize);
			return { locations: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.goToImplementation"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const locations = await goToImplementationQuery(lease.value.index, { path: input.path, line: input.line, character: input.character });
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(locations, maxResults, maxBytes, jsonByteSize);
			return { locations: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.findReferences"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const locations = await findReferencesQuery(
				lease.value.index,
				{ path: input.path, line: input.line, character: input.character },
				input.includeDeclaration,
			);
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(locations, maxResults, maxBytes, jsonByteSize);
			// See workspace.findSymbols' identical note on the concise/detailed type-vs-runtime tradeoff.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return formatProvenanced(
				{ locations: page, truncated, provenance: lease.value.index.provenance },
				input.responseFormat ?? "detailed",
			) as OperationOutputs["workspace.findReferences"];
		},
		async "workspace.documentHighlights"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			if (!lease.value.index.documentHighlights) throw new DocumentHighlightsNotSupported(input.workspaceId);
			const highlights = await documentHighlightsQuery(lease.value.index, { path: input.path, line: input.line, character: input.character });
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			// documentHighlightsQuery only returns undefined when index.documentHighlights is absent,
			// already ruled out above.
			const { page, truncated } = boundListFromStart(highlights ?? [], maxResults, maxBytes, jsonByteSize);
			return { highlights: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.hover"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const hover = await hoverAt(lease.value.index, { path: input.path, line: input.line, character: input.character });
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_HOVER_BYTES, MAX_HOVER_BYTES, "maxBytes");
			if (!hover) return { hover, truncated: false, provenance: lease.value.index.provenance };
			const bounded = truncateUtf8(hover.contents, maxBytes);
			return { hover: { ...hover, contents: bounded.value }, truncated: bounded.truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.documentSymbols"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const symbols = await documentSymbolsQuery(lease.value.index, input.path);
			const maxResults = resolveBound(input.maxResults, DEFAULT_DOCUMENT_SYMBOL_RESULTS, MAX_DOCUMENT_SYMBOL_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_DOCUMENT_SYMBOL_BYTES, MAX_DOCUMENT_SYMBOL_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(symbols, maxResults, maxBytes, jsonByteSize);
			return { symbols: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.diagnostics"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const diagnostics = await diagnosticsQuery(lease.value.index, input.path);
			const maxResults = resolveBound(input.maxResults, DEFAULT_DIAGNOSTIC_RESULTS, MAX_DIAGNOSTIC_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(diagnostics, maxResults, maxBytes, jsonByteSize);
			return { diagnostics: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.prepareCallHierarchy"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const items = await prepareCallHierarchyQuery(lease.value.index, { path: input.path, line: input.line, character: input.character });
			return { items, provenance: lease.value.index.provenance };
		},
		async "workspace.incomingCalls"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const calls = await incomingCallsQuery(lease.value.index, { path: input.path, line: input.line, character: input.character });
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(calls, maxResults, maxBytes, jsonByteSize);
			return { calls: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.outgoingCalls"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const calls = await outgoingCallsQuery(lease.value.index, { path: input.path, line: input.line, character: input.character });
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(calls, maxResults, maxBytes, jsonByteSize);
			return { calls: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.prepareTypeHierarchy"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const deadlineMs = resolveBound(input.deadlineMs, DEFAULT_TYPE_HIERARCHY_DEADLINE_MS, MAX_TYPE_HIERARCHY_DEADLINE_MS, "deadlineMs");
			const items = await withTypeHierarchyDeadline(prepareTypeHierarchy(lease.value.index, input), deadlineMs);
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(items, maxResults, maxBytes, jsonByteSize);
			return { items: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.supertypes"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const deadlineMs = resolveBound(input.deadlineMs, DEFAULT_TYPE_HIERARCHY_DEADLINE_MS, MAX_TYPE_HIERARCHY_DEADLINE_MS, "deadlineMs");
			const items = await withTypeHierarchyDeadline(supertypes(lease.value.index, input), deadlineMs);
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(items, maxResults, maxBytes, jsonByteSize);
			return { items: page, truncated, provenance: lease.value.index.provenance };
		},
		async "workspace.subtypes"(_registry, input) {
			await using lease = await requireCodeIntelligence(warmIndexes, input);
			const deadlineMs = resolveBound(input.deadlineMs, DEFAULT_TYPE_HIERARCHY_DEADLINE_MS, MAX_TYPE_HIERARCHY_DEADLINE_MS, "deadlineMs");
			const items = await withTypeHierarchyDeadline(subtypes(lease.value.index, input), deadlineMs);
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(items, maxResults, maxBytes, jsonByteSize);
			return { items: page, truncated, provenance: lease.value.index.provenance };
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
