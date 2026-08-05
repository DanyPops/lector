import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { InMemoryMutationHistory } from "../mutation-history/in-memory-mutation-history.ts";
import type { MutationOperation } from "../mutation-history/mutation-history.ts";
import { canRevertMutation } from "../mutation-history/mutation-history.ts";
import type { MutationHistoryPort } from "../mutation-history/port.ts";
import {
	type MutableRegistry,
	MutationEntryNotFound,
	MutationRevertStale,
	type OperationInputs,
	type OperationOutputs,
	resolveWorkspace,
	UnknownWorkspace,
	type WorkspaceId,
} from "../service.ts";

export interface MutationHistoryHandlerDeps {
	readonly registry: MutableRegistry;
	readonly createStore?: (workspaceId: WorkspaceId) => MutationHistoryPort;
}

export interface MutationHistoryHandlers {
	readonly "workspace.mutationHistory": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.mutationHistory"],
	) => Promise<OperationOutputs["workspace.mutationHistory"]>;
	readonly "workspace.revertMutation": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.revertMutation"],
	) => Promise<OperationOutputs["workspace.revertMutation"]>;
}

export class MutationHistoryCoordinator {
	private readonly stores = new Map<WorkspaceId, MutationHistoryPort>();
	private readonly createStore: (workspaceId: WorkspaceId) => MutationHistoryPort;
	readonly handlers: MutationHistoryHandlers;

	constructor(private readonly deps: MutationHistoryHandlerDeps) {
		this.createStore = deps.createStore ?? (() => new InMemoryMutationHistory());
		this.handlers = {
			"workspace.mutationHistory": async (_registry, input) => {
				if (!this.deps.registry.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
				return { entries: await this.store(input.workspaceId).listForPath(input.path, input.maxResults) };
			},
			"workspace.revertMutation": async (registry, input) => this.revert(registry, input),
		};
	}

	private store(workspaceId: WorkspaceId): MutationHistoryPort {
		let store = this.stores.get(workspaceId);
		if (!store) {
			store = this.createStore(workspaceId);
			this.stores.set(workspaceId, store);
		}
		return store;
	}

	async record<T extends { newHash: ContentHash | null }>(
		workspaceId: WorkspaceId,
		path: string,
		operation: MutationOperation,
		run: () => Promise<T>,
	): Promise<T> {
		const workspace = resolveWorkspace(this.deps.registry, workspaceId);
		const before = await workspace.readEntry(path);
		const beforeContent = before.exists ? before.content : null;
		const beforeHash = before.exists ? contentHashOf(before.content) : null;
		const outcome = await run();
		await this.store(workspaceId).record({ path, operation, beforeContent, beforeHash, afterHash: outcome.newHash });
		return outcome;
	}

	private async revert(registry: MutableRegistry, input: OperationInputs["workspace.revertMutation"]): Promise<OperationOutputs["workspace.revertMutation"]> {
		if (!this.deps.registry.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
		const target = await this.store(input.workspaceId).get(input.entryId);
		if (!target) throw new MutationEntryNotFound(input.entryId);
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const current = await workspace.readEntry(target.path);
		const currentHash = current.exists ? contentHashOf(current.content) : null;
		if (!canRevertMutation({ entry: target, currentHash })) throw new MutationRevertStale(input.entryId, target.path);
		const outcome = await this.record(input.workspaceId, target.path, "revert", async () => {
			if (target.beforeContent === null) {
				if (currentHash === null) throw new MutationRevertStale(input.entryId, target.path);
				await workspace.deleteEntry(target.path, currentHash);
				return { newHash: null };
			}
			const written = await workspace.writeEntry(target.path, currentHash, target.beforeContent);
			return { newHash: written.newHash };
		});
		return { path: target.path, newHash: outcome.newHash };
	}
}
