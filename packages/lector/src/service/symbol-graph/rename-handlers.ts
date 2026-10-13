import type { SerialExecutionQueue } from "../../concurrency/serial-execution-queue.ts";
import { type ContentHash, contentHashOf } from "../../content-identity/content-hash.ts";
import { applyReferenceBasedRename } from "../../reference-based-rename/apply-reference-based-rename.ts";
import { applyWorkspaceEdit, collectTouchedPaths } from "../../workspace/apply-workspace-edit.ts";
import type { ParsedWorkspaceEdit } from "../../workspace/workspace-edit.ts";
import { requireCodeIntelligence } from "../code-intelligence-handlers.ts";
import type { DiagnosticValidationCoordinator } from "../diagnostic-validation-coordinator.ts";
import { RenameNotSupported, SymbolQueryUnavailable, UnknownWorkspace, type WorkspaceId } from "../errors.ts";
import type { MutationHistoryCoordinator } from "../mutation-history-handlers.ts";
import type { OperationInputs, OperationOutputs } from "../operations.ts";
import type { WarmIndexRegistry } from "../warm-index-registry.ts";
import type { MutableRegistry } from "../workspace-registry.ts";
import { referenceRenamePlan } from "./reference-rename-plan.ts";

export interface RenameHandlerDeps {
	readonly cacheWalkedFiles: (
		registry: MutableRegistry,
		input: OperationInputs["workspace.cacheWalkedFiles"],
	) => Promise<OperationOutputs["workspace.cacheWalkedFiles"]>;
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly renameMutationBarrier: SerialExecutionQueue;
	readonly mutationHistory: MutationHistoryCoordinator;
	readonly diagnosticValidation?: DiagnosticValidationCoordinator;
	readonly cacheStatus: (registry: MutableRegistry, input: OperationInputs["workspace.cacheStatus"]) => Promise<OperationOutputs["workspace.cacheStatus"]>;
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
	const { registry, warmIndexes, renameMutationBarrier, mutationHistory, diagnosticValidation } = deps;

	async function referenceBasedRenameHandler(
		registryArg: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	): Promise<OperationOutputs["workspace.referenceBasedRename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);

		return renameMutationBarrier.run(input.workspaceId, async () => {
			const plan = await referenceRenamePlan(deps, registryArg, input);
			const changedPaths = [plan.move.fromPath, plan.move.toPath, ...plan.importRewrites.map((file) => file.path)];
			const affectedPaths = diagnosticValidation ? await diagnosticValidation.affectedPaths(input.workspaceId, changedPaths, 2, 500, 5_000) : [];
			const baseline = diagnosticValidation ? await diagnosticValidation.capture(input.workspaceId, affectedPaths, 30_000) : undefined;
			const outcome = await applyReferenceBasedRename(entry.port, plan);
			const transactionId = await mutationHistory.recordTransaction(input.workspaceId, "rename", outcome.steps);
			if (diagnosticValidation && baseline) {
				const after = await diagnosticValidation.capture(input.workspaceId, affectedPaths, 30_000);
				diagnosticValidation.record(transactionId, baseline, after);
			}
			return { movedTo: outcome.movedTo, filesUpdated: outcome.filesUpdated, caveats: outcome.caveats, transactionId };
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

			const affectedPaths = diagnosticValidation ? await diagnosticValidation.affectedPaths(input.workspaceId, collectTouchedPaths(edit), 2, 500, 5_000) : [];
			const baseline = diagnosticValidation ? await diagnosticValidation.capture(input.workspaceId, affectedPaths, 30_000) : undefined;

			await index.notifyFilesWillRename?.(renamePairs);
			await index.notifyFilesWillCreate?.(createPaths);
			await index.notifyFilesWillDelete?.(deletePaths);
			const outcome = await applyWorkspaceEdit(entry.port, edit, expectedHashes);
			index.notifyFilesDidRename?.(renamePairs);
			index.notifyFilesDidCreate?.(createPaths);
			index.notifyFilesDidDelete?.(deletePaths);
			const transactionId = outcome.steps.length > 0 ? await mutationHistory.recordTransaction(input.workspaceId, "rename", outcome.steps) : undefined;
			if (diagnosticValidation && baseline && transactionId) {
				const after = await diagnosticValidation.capture(input.workspaceId, affectedPaths, 30_000);
				diagnosticValidation.record(transactionId, baseline, after);
			}

			return { touchedPaths: outcome.touchedPaths, ...(transactionId ? { transactionId } : {}), provenance: index.provenance };
		});
	}

	return {
		"workspace.referenceBasedRename": referenceBasedRenameHandler,
		"workspace.prepareRename": prepareRenameHandler,
		"workspace.rename": renameHandler,
	};
}
