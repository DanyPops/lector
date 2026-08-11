import { boundListFromStart, jsonByteSize } from "../bounds/bound-list.ts";
import { truncateUtf8 } from "../bounds/truncate-utf8.ts";
import { dataFlowHintsForFile } from "../code-intelligence/data-flow-hints-for-file.ts";
import { narrowedTypeAtPosition } from "../code-intelligence/typescript-narrowed-type.ts";
import type { ContentCachePort } from "../content-cache/port.ts";
import type { SearchCachePort } from "../search-cache/port.ts";
import { findFiles as findFilesQuery } from "../text-search/find-files.ts";
import type { TextSearchPort } from "../text-search/port.ts";
import { searchText as searchTextQuery } from "../text-search/search-text.ts";
import { applyPatch } from "../workspace/apply-patch.ts";
import { exactEdit } from "../workspace/exact-edit.ts";
import { lineEdit } from "../workspace/line-edit.ts";
import { listDirectory } from "../workspace/list-directory.ts";
import { rawRead } from "../workspace/raw-read.ts";
import {
	DEFAULT_HOVER_BYTES,
	DEFAULT_LOCATION_BYTES,
	DEFAULT_LOCATION_RESULTS,
	MAX_HOVER_BYTES,
	MAX_LOCATION_BYTES,
	MAX_LOCATION_RESULTS,
	resolveBound,
} from "./bounds.ts";
import { SymbolQueryUnavailable, UnknownWorkspace, type WorkspaceId } from "./errors.ts";
import type { MutationHistoryCoordinator } from "./mutation-history-handlers.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import type { WarmIndexRegistry } from "./warm-index-registry.ts";
import { type MutableRegistry, resolveFileTree, resolveWorkspace } from "./workspace-registry.ts";

export interface WorkspaceFileHandlerDeps {
	readonly contentCache: ContentCachePort;
	readonly mutationHistory: MutationHistoryCoordinator;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly textSearch: TextSearchPort;
	readonly searchCache: SearchCachePort;
}

export interface WorkspaceFileHandlers {
	"workspace.listDirectory": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.listDirectory"],
	) => Promise<OperationOutputs["workspace.listDirectory"]>;
	"workspace.createDirectory": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.createDirectory"],
	) => Promise<OperationOutputs["workspace.createDirectory"]>;
	"workspace.renamePath": (registry: MutableRegistry, input: OperationInputs["workspace.renamePath"]) => Promise<OperationOutputs["workspace.renamePath"]>;
	"workspace.deleteDirectory": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.deleteDirectory"],
	) => Promise<OperationOutputs["workspace.deleteDirectory"]>;
	"workspace.rawRead": (registry: MutableRegistry, input: OperationInputs["workspace.rawRead"]) => Promise<OperationOutputs["workspace.rawRead"]>;
	"workspace.exactEdit": (registry: MutableRegistry, input: OperationInputs["workspace.exactEdit"]) => Promise<OperationOutputs["workspace.exactEdit"]>;
	"workspace.deleteEntry": (registry: MutableRegistry, input: OperationInputs["workspace.deleteEntry"]) => Promise<OperationOutputs["workspace.deleteEntry"]>;
	"workspace.lineEdit": (registry: MutableRegistry, input: OperationInputs["workspace.lineEdit"]) => Promise<OperationOutputs["workspace.lineEdit"]>;
	"workspace.applyPatch": (registry: MutableRegistry, input: OperationInputs["workspace.applyPatch"]) => Promise<OperationOutputs["workspace.applyPatch"]>;
	"workspace.searchText": (registry: MutableRegistry, input: OperationInputs["workspace.searchText"]) => Promise<OperationOutputs["workspace.searchText"]>;
	"workspace.findFiles": (registry: MutableRegistry, input: OperationInputs["workspace.findFiles"]) => Promise<OperationOutputs["workspace.findFiles"]>;
	"workspace.dataFlowHints": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.dataFlowHints"],
	) => Promise<OperationOutputs["workspace.dataFlowHints"]>;
	"workspace.narrowedType": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.narrowedType"],
	) => Promise<OperationOutputs["workspace.narrowedType"]>;
}

/**
 * Every direct filesystem-tree/content operation: directory tree mutation (listDirectory/
 * createDirectory/renamePath/deleteDirectory, via FileTreePort), guarded content mutation
 * (rawRead/exactEdit/deleteEntry/lineEdit/applyPatch, via WorkspacePort + MutationHistoryCoordinator
 * + WarmIndexRegistry's will/did notifications), and workspace-scoped search (searchText/findFiles).
 * Deliberately excludes workspace.registerPath (a real module-level function in service.ts with no
 * closure state -- nothing to gain by relocating it) and every code-intelligence/symbol-graph
 * operation (see code-intelligence-handlers.ts / symbol-graph-handlers.ts).
 */
export function createWorkspaceFileHandlers(deps: WorkspaceFileHandlerDeps): WorkspaceFileHandlers {
	const { contentCache, mutationHistory, warmIndexes, textSearch, searchCache } = deps;

	return {
		"workspace.listDirectory": (registry, input) => listDirectory(resolveFileTree(registry, input.workspaceId), input.path),
		async "workspace.createDirectory"(registry, input) {
			await resolveFileTree(registry, input.workspaceId).createDirectory(input.path);
			return { path: input.path };
		},
		async "workspace.renamePath"(registry, input) {
			await resolveFileTree(registry, input.workspaceId).renamePath(input.oldPath, input.newPath);
			return { oldPath: input.oldPath, newPath: input.newPath };
		},
		async "workspace.deleteDirectory"(registry, input) {
			await resolveFileTree(registry, input.workspaceId).deleteDirectory(input.path);
			return { path: input.path };
		},
		async "workspace.rawRead"(registry, input) {
			const read = await rawRead(resolveWorkspace(registry, input.workspaceId), input.path);
			await contentCache.putRawContent(read.hash, read.content);
			return read;
		},
		// Pure tree-sitter/syntactic -- no warm LSP index, no IntelligenceProvenance: see
		// DataFlowHint's own doc comment for why this is a heuristic, not a real dataflow graph.
		async "workspace.dataFlowHints"(registry, input) {
			const hints = await dataFlowHintsForFile(resolveWorkspace(registry, input.workspaceId), input.path);
			const maxResults = resolveBound(input.maxResults, DEFAULT_LOCATION_RESULTS, MAX_LOCATION_RESULTS, "maxResults");
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_LOCATION_BYTES, MAX_LOCATION_BYTES, "maxBytes");
			const { page, truncated } = boundListFromStart(hints, maxResults, maxBytes, jsonByteSize);
			return { hints: page, truncated };
		},
		// Real TypeScript-compiler-API flow narrowing (see typescript-narrowed-type.ts's own doc
		// comment) -- also no warm LSP index and no IntelligenceProvenance: a genuinely different
		// backend (a fresh single-file ts.Program per call, not the shared warm tsserver process
		// code-intelligence-handlers.ts's operations lease).
		async "workspace.narrowedType"(registry, input) {
			const workspace = resolveWorkspace(registry, input.workspaceId);
			const absolutePath = workspace.resolvePath(input.path);
			const type = await narrowedTypeAtPosition(absolutePath, input.line, input.character);
			const maxBytes = resolveBound(input.maxBytes, DEFAULT_HOVER_BYTES, MAX_HOVER_BYTES, "maxBytes");
			if (!type) return { type: undefined, truncated: false };
			const boundedDeclared = truncateUtf8(type.declaredType, maxBytes);
			const boundedNarrowed = truncateUtf8(type.narrowedType, maxBytes);
			return {
				type: { declaredType: boundedDeclared.value, narrowedType: boundedNarrowed.value, narrowed: type.narrowed },
				truncated: boundedDeclared.truncated || boundedNarrowed.truncated,
			};
		},
		async "workspace.exactEdit"(registry, input) {
			const { workspaceId, ...edit } = input;
			const workspace = resolveWorkspace(registry, workspaceId);
			const resolvedPath = workspace.resolvePath(edit.path);
			if (edit.expectedHash === null) await warmIndexes.notifyFilesWillCreate(workspaceId, [resolvedPath]);
			const outcome = await mutationHistory.record(workspaceId, edit.path, "exactEdit", () => exactEdit(workspace, edit));
			if (edit.expectedHash === null) warmIndexes.notifyFilesDidCreate(workspaceId, [resolvedPath]);
			await contentCache.putRawContent(outcome.newHash, edit.content);
			return outcome;
		},
		async "workspace.deleteEntry"(registry, input) {
			const workspace = resolveWorkspace(registry, input.workspaceId);
			const resolvedPath = workspace.resolvePath(input.path);
			await warmIndexes.notifyFilesWillDelete(input.workspaceId, [resolvedPath]);
			const outcome = await mutationHistory.record(input.workspaceId, input.path, "delete", async () => {
				const result = await workspace.deleteEntry(input.path, input.expectedHash);
				return { newHash: null, previousHash: result.previousHash };
			});
			warmIndexes.notifyFilesDidDelete(input.workspaceId, [resolvedPath]);
			return { path: input.path, previousHash: outcome.previousHash };
		},
		"workspace.lineEdit"(registry, input) {
			return mutationHistory.record(input.workspaceId, input.path, "lineEdit", () =>
				lineEdit(resolveWorkspace(registry, input.workspaceId), { path: input.path, edits: input.edits }),
			);
		},
		"workspace.applyPatch"(registry, input) {
			return mutationHistory.record(input.workspaceId, input.path, "applyPatch", () =>
				applyPatch(resolveWorkspace(registry, input.workspaceId), { path: input.path, expectedHash: input.expectedHash, patchText: input.patchText }),
			);
		},
		async "workspace.searchText"(registry, input) {
			const entry = registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
			return searchTextQuery(textSearch, searchCache, entry.rootPath, input.workspaceId, input.query, {
				maxMatches: input.maxMatches,
				maxBytes: input.maxBytes,
			});
		},
		async "workspace.findFiles"(registry, input) {
			const entry = registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
			return findFilesQuery(textSearch, entry.rootPath, input.patterns, { maxResults: input.maxResults, maxBytes: input.maxBytes });
		},
	};
}
