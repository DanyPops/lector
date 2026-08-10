import { randomUUID } from "node:crypto";
import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { boundMutationHistoryEntries } from "../mutation-history/bound-mutation-history-entries.ts";
import { InMemoryMutationHistory } from "../mutation-history/in-memory-mutation-history.ts";
import type { MutationHistoryEntry, MutationOperation } from "../mutation-history/mutation-history.ts";
import { canRevertMutation } from "../mutation-history/mutation-history.ts";
import { planMutationTransactionRevert } from "../mutation-history/plan-mutation-transaction-revert.ts";
import type { MutationHistoryPort } from "../mutation-history/port.ts";
import {
	DEFAULT_MUTATION_HISTORY_BYTES,
	DEFAULT_MUTATION_HISTORY_RESULTS,
	MAX_MUTATION_HISTORY_BYTES,
	MAX_MUTATION_HISTORY_ENTRY_CONTENT_BYTES,
	MAX_MUTATION_HISTORY_RESULTS,
	resolveBound,
} from "./bounds.ts";
import {
	MutationEntryNotFound,
	MutationRevertStale,
	MutationTransactionNotFound,
	MutationTransactionRevertStale,
	UnknownWorkspace,
	type WorkspaceId,
} from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { type MutableRegistry, resolveWorkspace } from "./workspace-registry.ts";

/** One recorded step of a rename/multi-file transaction -- afterHash null means this step's own result was "the path no longer exists" (the source half of a rename). */
export interface MutationTransactionStep {
	readonly path: string;
	readonly beforeContent: string | null;
	readonly afterHash: ContentHash | null;
}

export interface WorkspaceFileOperationObserver {
	notifyFilesWillCreate(workspaceId: WorkspaceId, paths: readonly string[]): Promise<void>;
	notifyFilesDidCreate(workspaceId: WorkspaceId, paths: readonly string[]): void;
	notifyFilesWillDelete(workspaceId: WorkspaceId, paths: readonly string[]): Promise<void>;
	notifyFilesDidDelete(workspaceId: WorkspaceId, paths: readonly string[]): void;
}

export interface MutationHistoryHandlerDeps {
	readonly registry: MutableRegistry;
	readonly createStore?: (workspaceId: WorkspaceId) => MutationHistoryPort;
	readonly fileOperations?: WorkspaceFileOperationObserver;
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
	readonly "workspace.mutationTransaction": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.mutationTransaction"],
	) => Promise<OperationOutputs["workspace.mutationTransaction"]>;
	readonly "workspace.revertMutationTransaction": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.revertMutationTransaction"],
	) => Promise<OperationOutputs["workspace.revertMutationTransaction"]>;
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
				const maxResults = resolveBound(input.maxResults, DEFAULT_MUTATION_HISTORY_RESULTS, MAX_MUTATION_HISTORY_RESULTS, "maxResults");
				const maxBytes = resolveBound(input.maxBytes, DEFAULT_MUTATION_HISTORY_BYTES, MAX_MUTATION_HISTORY_BYTES, "maxBytes");
				const stored = await this.store(input.workspaceId).listForPath(input.path, maxResults);
				return boundMutationHistoryEntries(stored, maxResults, maxBytes, MAX_MUTATION_HISTORY_ENTRY_CONTENT_BYTES);
			},
			"workspace.revertMutation": async (registry, input) => this.revert(registry, input),
			"workspace.mutationTransaction": async (_registry, input) => {
				if (!this.deps.registry.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
				const entries = await this.store(input.workspaceId).listByTransaction(input.transactionId);
				if (entries.length === 0) throw new MutationTransactionNotFound(input.transactionId);
				const bounded = boundMutationHistoryEntries(
					entries,
					MAX_MUTATION_HISTORY_RESULTS,
					MAX_MUTATION_HISTORY_BYTES,
					MAX_MUTATION_HISTORY_ENTRY_CONTENT_BYTES,
				);
				return { transactionId: input.transactionId, ...bounded };
			},
			"workspace.revertMutationTransaction": async (registry, input) => this.revertTransaction(registry, input),
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
		await this.store(workspaceId).record({ path, operation, beforeContent, beforeHash, afterHash: outcome.newHash, transactionId: null });
		return outcome;
	}

	/**
	 * Records N steps (a semantic rename's own WorkspaceEdit, or a reference-based file rename)
	 * under one shared transaction id -- a caller must never present these as independently
	 * revertible when imports and declarations changed together. Returns the transaction id for a
	 * later workspace.mutationTransaction preview or workspace.revertMutationTransaction call.
	 */
	async recordTransaction(workspaceId: WorkspaceId, operation: MutationOperation, steps: readonly MutationTransactionStep[]): Promise<string> {
		const transactionId = randomUUID();
		const store = this.store(workspaceId);
		for (const step of steps) {
			const beforeHash = step.beforeContent !== null ? contentHashOf(step.beforeContent) : null;
			await store.record({ path: step.path, operation, beforeContent: step.beforeContent, beforeHash, afterHash: step.afterHash, transactionId });
		}
		return transactionId;
	}

	private async revert(registry: MutableRegistry, input: OperationInputs["workspace.revertMutation"]): Promise<OperationOutputs["workspace.revertMutation"]> {
		if (!this.deps.registry.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
		const target = await this.store(input.workspaceId).get(input.entryId);
		if (!target) throw new MutationEntryNotFound(input.entryId);
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const current = await workspace.readEntry(target.path);
		const currentHash = current.exists ? contentHashOf(current.content) : null;
		if (!canRevertMutation({ entry: target, currentHash })) throw new MutationRevertStale(input.entryId, target.path);
		const resolvedPath = workspace.resolvePath(target.path);
		const createsFile = target.beforeContent !== null && currentHash === null;
		const deletesFile = target.beforeContent === null;
		if (createsFile) await this.deps.fileOperations?.notifyFilesWillCreate(input.workspaceId, [resolvedPath]);
		if (deletesFile) await this.deps.fileOperations?.notifyFilesWillDelete(input.workspaceId, [resolvedPath]);
		const outcome = await this.record(input.workspaceId, target.path, "revert", async () => {
			if (target.beforeContent === null) {
				if (currentHash === null) throw new MutationRevertStale(input.entryId, target.path);
				await workspace.deleteEntry(target.path, currentHash);
				return { newHash: null };
			}
			const written = await workspace.writeEntry(target.path, currentHash, target.beforeContent);
			return { newHash: written.newHash };
		});
		if (createsFile) this.deps.fileOperations?.notifyFilesDidCreate(input.workspaceId, [resolvedPath]);
		if (deletesFile) this.deps.fileOperations?.notifyFilesDidDelete(input.workspaceId, [resolvedPath]);
		return { path: target.path, newHash: outcome.newHash };
	}

	/**
	 * Reverts every member of a rename/multi-file transaction, all-or-nothing: the pre-flight check
	 * (planMutationTransactionRevert) refuses the whole thing before touching anything if even one
	 * member is stale, and a genuine race during application (a write/delete losing to something
	 * else between the pre-flight check and its own hash guard) rolls back every step already
	 * reverted in this call, mirroring applyWorkspaceEdit's own all-or-nothing discipline. The
	 * revert itself is recorded as a further-revertible transaction, generalizing single-entry
	 * revert's "U undoes U" to N files.
	 */
	private async revertTransaction(
		registry: MutableRegistry,
		input: OperationInputs["workspace.revertMutationTransaction"],
	): Promise<OperationOutputs["workspace.revertMutationTransaction"]> {
		if (!this.deps.registry.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
		const entries = await this.store(input.workspaceId).listByTransaction(input.transactionId);
		if (entries.length === 0) throw new MutationTransactionNotFound(input.transactionId);
		const workspace = resolveWorkspace(registry, input.workspaceId);

		const currentReads = new Map<string, { readonly exists: boolean; readonly content: string }>();
		for (const entry of entries) {
			if (currentReads.has(entry.path)) continue;
			const read = await workspace.readEntry(entry.path);
			currentReads.set(entry.path, read.exists ? { exists: true, content: read.content } : { exists: false, content: "" });
		}
		const currentHashes = new Map<string, ContentHash | null>();
		for (const [path, read] of currentReads) currentHashes.set(path, read.exists ? contentHashOf(read.content) : null);

		const plan = planMutationTransactionRevert(entries, currentHashes);
		if (!plan.safe) throw new MutationTransactionRevertStale(input.transactionId, plan.staleEntry.path);

		const resolvedPaths = new Map<string, string>();
		for (const entry of entries) resolvedPaths.set(entry.path, workspace.resolvePath(entry.path));
		const creates = entries.filter((entry) => entry.beforeContent !== null && currentHashes.get(entry.path) === null);
		const deletes = entries.filter((entry) => entry.beforeContent === null);
		if (creates.length > 0)
			await this.deps.fileOperations?.notifyFilesWillCreate(
				input.workspaceId,
				creates.map((entry) => resolvedPaths.get(entry.path) ?? entry.path),
			);
		if (deletes.length > 0)
			await this.deps.fileOperations?.notifyFilesWillDelete(
				input.workspaceId,
				deletes.map((entry) => resolvedPaths.get(entry.path) ?? entry.path),
			);

		const applied: MutationHistoryEntry[] = [];
		async function rollbackApplied(): Promise<void> {
			for (const entry of [...applied].reverse()) {
				const read = currentReads.get(entry.path);
				if (!read) continue;
				if (read.exists) await workspace.writeEntry(entry.path, entry.afterHash, read.content);
				else if (entry.afterHash !== null) await workspace.deleteEntry(entry.path, entry.afterHash);
			}
		}

		const steps: MutationTransactionStep[] = [];
		try {
			for (const entry of entries) {
				const currentHash = currentHashes.get(entry.path) ?? null;
				if (entry.beforeContent === null) {
					if (currentHash === null) throw new MutationTransactionRevertStale(input.transactionId, entry.path);
					await workspace.deleteEntry(entry.path, currentHash);
					steps.push({ path: entry.path, beforeContent: currentReads.get(entry.path)?.content ?? null, afterHash: null });
				} else {
					const written = await workspace.writeEntry(entry.path, currentHash, entry.beforeContent);
					steps.push({
						path: entry.path,
						beforeContent: currentReads.get(entry.path)?.exists ? (currentReads.get(entry.path)?.content ?? null) : null,
						afterHash: written.newHash,
					});
				}
				applied.push(entry);
			}
		} catch (error) {
			await rollbackApplied();
			throw error;
		}

		const revertTransactionId = await this.recordTransaction(input.workspaceId, "revert", steps);
		for (const entry of creates) this.deps.fileOperations?.notifyFilesDidCreate(input.workspaceId, [resolvedPaths.get(entry.path) ?? entry.path]);
		for (const entry of deletes) this.deps.fileOperations?.notifyFilesDidDelete(input.workspaceId, [resolvedPaths.get(entry.path) ?? entry.path]);

		return {
			transactionId: revertTransactionId,
			reverted: entries.map((entry) => ({ path: entry.path, newHash: entry.beforeContent === null ? null : contentHashOf(entry.beforeContent) })),
		};
	}
}
