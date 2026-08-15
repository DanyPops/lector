import { extname } from "node:path";
import type { DocumentSymbolEntry } from "../../code-intelligence/document-symbol.ts";
import { documentSymbols as documentSymbolsQuery } from "../../code-intelligence/document-symbols.ts";
import { findReferences as findReferencesQuery } from "../../code-intelligence/find-references.ts";
import { findImportSpecifiers } from "../../code-intelligence/tree-sitter/import-specifiers.ts";
import type { SerialExecutionQueue } from "../../concurrency/serial-execution-queue.ts";
import { type ContentHash, contentHashOf } from "../../content-identity/content-hash.ts";
import { applyReferenceBasedRename } from "../../reference-based-rename/apply-reference-based-rename.ts";
import { planReferenceBasedRename } from "../../reference-based-rename/reference-based-rename.ts";
import { applyWorkspaceEdit, collectTouchedPaths } from "../../workspace/apply-workspace-edit.ts";
import { WorkspaceEntryNotFound } from "../../workspace/raw-read.ts";
import type { ParsedWorkspaceEdit } from "../../workspace/workspace-edit.ts";
import { MAX_POPULATE_RETRY_BUDGET_MS } from "../bounds.ts";
import { requireCodeIntelligence } from "../code-intelligence-handlers.ts";
import { ReferenceBasedRenameRequiresFreshGraph, RenameNotSupported, SymbolQueryUnavailable, UnknownWorkspace, type WorkspaceId } from "../errors.ts";
import type { MutationHistoryCoordinator } from "../mutation-history-handlers.ts";
import type { OperationInputs, OperationOutputs } from "../operations.ts";
import type { WarmIndexRegistry } from "../warm-index-registry.ts";
import type { MutableRegistry } from "../workspace-registry.ts";

export interface RenameHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly renameMutationBarrier: SerialExecutionQueue;
	readonly mutationHistory: MutationHistoryCoordinator;
	readonly cacheStatus: (
		registry: MutableRegistry,
		input: OperationInputs["workspace.cacheStatus"],
	) => Promise<OperationOutputs["workspace.cacheStatus"]>;
	readonly populateSymbolGraph: (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
}

export interface RenameHandlers {
	"workspace.referenceBasedRename": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	) => Promise<OperationOutputs["workspace.referenceBasedRename"]>;
	"workspace.prepareRename": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.prepareRename"],
	) => Promise<OperationOutputs["workspace.prepareRename"]>;
	"workspace.rename": (registry: MutableRegistry, input: OperationInputs["workspace.rename"]) => Promise<OperationOutputs["workspace.rename"]>;
}

/** referenceBasedRename/prepareRename/rename -- the only operations needing BOTH a fully-cached graph (referenceBasedRename checks cacheStatus, optionally triggers populateSymbolGraph) and a live warm index. */
export function createRenameHandlers(deps: RenameHandlerDeps): RenameHandlers {
	const { registry, warmIndexes, renameMutationBarrier, mutationHistory, cacheStatus, populateSymbolGraph } = deps;

	/** Every top-level document symbol's own selectionRange -- deliberately not descending into `children` (a class method can't itself be reached via a module specifier, only the file's own top-level exports can be). */
	function flattenTopLevelPositions(symbols: readonly DocumentSymbolEntry[], path: string): Array<{ path: string; line: number; character: number }> {
		return symbols.map((symbol) => ({ path, line: symbol.selectionRange.start.line, character: symbol.selectionRange.start.character }));
	}

	async function referenceBasedRenameHandler(
		registryArg: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	): Promise<OperationOutputs["workspace.referenceBasedRename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);

		return renameMutationBarrier.run(input.workspaceId, async () => {
			// Point 6 of this operation's own design: refuse outright, before touching anything, unless
			// the symbol graph is fully "cached" for these exact bounds -- a "partial" or "not-cached"
			// graph cannot honestly enumerate every reference, and CodeScaleBench's own finding is that a
			// partial multi-file change scores WORSE than no change at all.
			let status = await cacheStatus(registry, {
				workspaceId: input.workspaceId,
				maxFiles: input.maxFiles,
				maxSymbolsPerFile: input.maxSymbolsPerFile,
			});
			// "not-cached" (no generation yet, or one recorded at different bounds/against now-stale
			// source) is the only status safe to recover from automatically -- there is no
			// partial/incomplete data to distrust, only an absent one. Opt-in via autoPopulate (see
			// workspace.referenceBasedRename's own doc comment for why this workspace is not always the
			// caller's correct final scope). "partial" (real per-file failures that already survived
			// populateSymbolGraph's own internal transient retry) and "caching"/"waiting-for-resources"
			// (another population already in flight) are never recovered from regardless of this flag --
			// blindly retrying the former would likely reproduce the same failures, and safely waiting on
			// the latter from inside this synchronous call is its own separate, more carefully-scoped
			// concern.
			if (input.autoPopulate && status.status === "not-cached") {
				await populateSymbolGraph(registryArg, {
					workspaceId: input.workspaceId,
					maxFiles: input.maxFiles,
					maxSymbolsPerFile: input.maxSymbolsPerFile,
					retryTimeBudgetMs: MAX_POPULATE_RETRY_BUDGET_MS,
				});
				status = await cacheStatus(registry, {
					workspaceId: input.workspaceId,
					maxFiles: input.maxFiles,
					maxSymbolsPerFile: input.maxSymbolsPerFile,
				});
			}
			if (status.status !== "cached") throw new ReferenceBasedRenameRequiresFreshGraph(input.workspaceId, status.status);

			const fromPath = entry.port.resolvePath(input.fromPath);
			const toPath = entry.port.resolvePath(input.toPath);

			await using indexLease = await requireCodeIntelligence(warmIndexes, { workspaceId: input.workspaceId, path: fromPath });
			const { index } = indexLease.value;
			const topLevelSymbols = await documentSymbolsQuery(index, fromPath);
			const positions = flattenTopLevelPositions(topLevelSymbols, fromPath);

			const referencingPaths = new Set<string>();
			for (const position of positions) {
				const locations = await findReferencesQuery(index, { path: position.path, line: position.line, character: position.character }, false);
				for (const location of locations) {
					const locationPath = entry.port.resolvePath(location.path);
					if (locationPath !== fromPath) referencingPaths.add(locationPath);
				}
			}

			const referencingFiles = [];
			for (const path of referencingPaths) {
				const read = await entry.port.readEntry(path);
				if (!read.exists) continue;
				const hash = contentHashOf(read.content);
				const importSpecifiers = await findImportSpecifiers(read.content, extname(path));
				referencingFiles.push({ path, content: read.content, hash, importSpecifiers });
			}

			const movedFile = await entry.port.readEntry(fromPath);
			if (!movedFile.exists) throw new WorkspaceEntryNotFound(fromPath);

			const plan = planReferenceBasedRename({
				fromPath,
				toPath,
				movedFileContent: movedFile.content,
				movedFileHash: contentHashOf(movedFile.content),
				referencingFiles,
			});

			const outcome = await applyReferenceBasedRename(entry.port, plan);
			await mutationHistory.recordTransaction(input.workspaceId, "rename", outcome.steps);
			return { movedTo: outcome.movedTo, filesUpdated: outcome.filesUpdated, caveats: outcome.caveats };
		});
	}

	async function prepareRenameHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.prepareRename"],
	): Promise<OperationOutputs["workspace.prepareRename"]> {
		await using indexLease = await requireCodeIntelligence(warmIndexes, input);
		const { index } = indexLease.value;
		if (!index.prepareRename) throw new RenameNotSupported(input.workspaceId);
		const range = await index.prepareRename({ path: input.path, line: input.line, character: input.character });
		return { range, provenance: index.provenance };
	}

	async function renameHandler(_registry: MutableRegistry, input: OperationInputs["workspace.rename"]): Promise<OperationOutputs["workspace.rename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		await using indexLease = await requireCodeIntelligence(warmIndexes, input);
		const { index } = indexLease.value;
		if (!index.rename) throw new RenameNotSupported(input.workspaceId);
		const rename = index.rename.bind(index);

		return renameMutationBarrier.run(input.workspaceId, async () => {
			const edit: ParsedWorkspaceEdit = await rename({ path: input.path, line: input.line, character: input.character }, input.newName);
			const renamePairs = edit.operations.filter((op) => op.kind === "rename").map((op) => ({ fromPath: op.fromPath, toPath: op.toPath }));
			const createPaths = edit.operations.filter((op) => op.kind === "create").map((op) => op.path);
			const deletePaths = edit.operations.filter((op) => op.kind === "delete").map((op) => op.path);

			// The caller's own snapshot of every touched path's current hash -- taken immediately
			// before applying, as close as Lector can get to "what the server actually saw" without
			// re-running its own analysis. applyWorkspaceEdit validates every step against this,
			// never a fresh read taken mid-apply (see its own doc comment for why that would catch
			// nothing).
			const expectedHashes = new Map<string, ContentHash | null>();
			for (const path of collectTouchedPaths(edit)) {
				const read = await entry.port.readEntry(path);
				expectedHashes.set(path, read.exists ? contentHashOf(read.content) : null);
			}

			await index.notifyFilesWillRename?.(renamePairs);
			await index.notifyFilesWillCreate?.(createPaths);
			await index.notifyFilesWillDelete?.(deletePaths);
			const outcome = await applyWorkspaceEdit(entry.port, edit, expectedHashes);
			index.notifyFilesDidRename?.(renamePairs);
			index.notifyFilesDidCreate?.(createPaths);
			index.notifyFilesDidDelete?.(deletePaths);
			if (outcome.steps.length > 0) await mutationHistory.recordTransaction(input.workspaceId, "rename", outcome.steps);

			return { touchedPaths: outcome.touchedPaths, provenance: index.provenance };
		});
	}

	return {
		"workspace.referenceBasedRename": referenceBasedRenameHandler,
		"workspace.prepareRename": prepareRenameHandler,
		"workspace.rename": renameHandler,
	};
}
