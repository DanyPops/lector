import { randomUUID } from "node:crypto";
import type { SemanticCodeAction } from "../code-intelligence/code-action.ts";
import { type CodeActionPreview, type CodeActionPreviewId, CodeActionsUnavailable, codeActionPreviewId } from "../code-intelligence/code-action.ts";
import type { SerialExecutionQueue } from "../concurrency/serial-execution-queue.ts";
import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { applyWorkspaceEdit, collectTouchedPaths } from "../workspace/apply-workspace-edit.ts";
import { StaleExpectedHash } from "../workspace/exact-edit.ts";
import type { ParsedWorkspaceEdit } from "../workspace/workspace-edit.ts";
import { requireCodeIntelligence } from "./code-intelligence-handlers.ts";
import type { DiagnosticValidationCoordinator } from "./diagnostic-validation-coordinator.ts";
import { UnknownWorkspace, type WorkspaceId } from "./errors.ts";
import type { MutationHistoryCoordinator } from "./mutation-history-handlers.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import type { WarmIndexRegistry } from "./warm-index-registry.ts";
import type { MutableRegistry } from "./workspace-registry.ts";

const MAX_RETAINED_PREVIEWS = 128;
const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_ONLY_KINDS = 20;
const MAX_DIAGNOSTICS = 1_000;
const MAX_ACTIONS = 100;
const MAX_EDITS = 10_000;
const MAX_FILES = 500;
const MAX_BYTES = 1_048_576;
const MAX_DEADLINE_MS = 120_000;

interface StoredPreview {
	readonly workspaceId: WorkspaceId;
	readonly action: SemanticCodeAction;
	readonly expectedHashes: ReadonlyMap<string, ContentHash | null>;
	readonly createdAt: number;
}

export class InvalidCodeActionRequest extends Error {
	constructor(readonly reason: string) {
		super(`invalid code-action request: ${reason}`);
		this.name = "InvalidCodeActionRequest";
	}
}

export class CodeActionPreviewUnavailable extends Error {
	constructor(readonly previewId: CodeActionPreviewId) {
		super(`code-action preview "${previewId}" is unknown or expired`);
		this.name = "CodeActionPreviewUnavailable";
	}
}

export class CodeActionCommandDenied extends Error {
	constructor(readonly previewId: CodeActionPreviewId) {
		super(`code-action preview "${previewId}" requires command execution, which guarded apply does not permit`);
		this.name = "CodeActionCommandDenied";
	}
}

export class StaleCodeActionDocumentVersion extends Error {
	constructor(
		readonly path: string,
		readonly expected: number,
		readonly actual: number | undefined,
	) {
		super(`code-action edit for "${path}" expected document version ${expected}, current version is ${actual ?? "unavailable"}`);
		this.name = "StaleCodeActionDocumentVersion";
	}
}

export class DisabledCodeAction extends Error {
	constructor(
		readonly previewId: CodeActionPreviewId,
		readonly reason: string,
	) {
		super(`code-action preview "${previewId}" is disabled: ${reason}`);
		this.name = "DisabledCodeAction";
	}
}

function editCount(edit: ParsedWorkspaceEdit): number {
	return edit.operations.reduce((count, operation) => count + (operation.kind === "text" ? operation.edits.length : 1), 0);
}

function byteSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fileOperationParts(edit: ParsedWorkspaceEdit): {
	renamePairs: Array<{ fromPath: string; toPath: string }>;
	createPaths: string[];
	deletePaths: string[];
} {
	return {
		renamePairs: edit.operations
			.filter((operation) => operation.kind === "rename")
			.map((operation) => ({ fromPath: operation.fromPath, toPath: operation.toPath })),
		createPaths: edit.operations.filter((operation) => operation.kind === "create").map((operation) => operation.path),
		deletePaths: edit.operations.filter((operation) => operation.kind === "delete").map((operation) => operation.path),
	};
}

export interface CodeActionHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly mutationBarrier: SerialExecutionQueue;
	readonly mutationHistory: MutationHistoryCoordinator;
	readonly diagnosticValidation?: DiagnosticValidationCoordinator;
	readonly now?: () => number;
}

/** Coordinates bounded language-server previews with hash-guarded, atomic application. */
export class CodeActionHandlers {
	private readonly previews = new Map<CodeActionPreviewId, StoredPreview>();
	private readonly now: () => number;

	constructor(private readonly deps: CodeActionHandlerDeps) {
		this.now = deps.now ?? Date.now;
	}

	readonly handlers = {
		"workspace.previewCodeActions": async (
			_registry: MutableRegistry,
			input: OperationInputs["workspace.previewCodeActions"],
		): Promise<OperationOutputs["workspace.previewCodeActions"]> => this.preview(input),
		"workspace.applyCodeAction": async (
			_registry: MutableRegistry,
			input: OperationInputs["workspace.applyCodeAction"],
		): Promise<OperationOutputs["workspace.applyCodeAction"]> => this.apply(input),
	};

	private prune(): void {
		const expiredBefore = this.now() - PREVIEW_TTL_MS;
		for (const [id, preview] of this.previews) if (preview.createdAt < expiredBefore) this.previews.delete(id);
		while (this.previews.size >= MAX_RETAINED_PREVIEWS) {
			const oldest = this.previews.keys().next().value;
			if (oldest === undefined) break;
			this.previews.delete(oldest);
		}
	}

	private async preview(input: OperationInputs["workspace.previewCodeActions"]): Promise<OperationOutputs["workspace.previewCodeActions"]> {
		if (input.maxActions < 1 || input.maxEdits < 1 || input.maxFiles < 1 || input.maxBytes < 1 || input.deadlineMs < 1) {
			throw new InvalidCodeActionRequest("bounds must all be positive");
		}
		if (
			input.maxActions > MAX_ACTIONS ||
			input.maxEdits > MAX_EDITS ||
			input.maxFiles > MAX_FILES ||
			input.maxBytes > MAX_BYTES ||
			input.deadlineMs > MAX_DEADLINE_MS
		) {
			throw new InvalidCodeActionRequest("bounds exceed service limits");
		}
		if ((input.only?.length ?? 0) > MAX_ONLY_KINDS) throw new InvalidCodeActionRequest(`only exceeds ${MAX_ONLY_KINDS} kinds`);
		if ((input.diagnostics?.length ?? 0) > MAX_DIAGNOSTICS) throw new InvalidCodeActionRequest(`diagnostics exceed ${MAX_DIAGNOSTICS} entries`);
		const entry = this.deps.registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		const sourcePath = entry.port.resolvePath(input.path);
		await using lease = await requireCodeIntelligence(this.deps.warmIndexes, { workspaceId: input.workspaceId, path: sourcePath });
		const { index } = lease.value;
		if (!index.codeActions) throw new CodeActionsUnavailable(index.provenance.backend);
		const sourceRead = await entry.port.readEntry(sourcePath);
		const sourceHash = sourceRead.exists ? contentHashOf(sourceRead.content) : null;
		const deadlineAt = this.now() + input.deadlineMs;
		const diagnostics =
			input.diagnostics ??
			(await index.diagnostics(sourcePath, { timeoutMs: input.deadlineMs }))
				.filter((diagnostic) => {
					const startsBeforeEnd =
						diagnostic.range.start.line < input.range.end.line ||
						(diagnostic.range.start.line === input.range.end.line && diagnostic.range.start.character <= input.range.end.character);
					const endsAfterStart =
						diagnostic.range.end.line > input.range.start.line ||
						(diagnostic.range.end.line === input.range.start.line && diagnostic.range.end.character >= input.range.start.character);
					return startsBeforeEnd && endsAfterStart;
				})
				.slice(0, MAX_DIAGNOSTICS);
		const candidates = await index.codeActions({
			path: sourcePath,
			range: input.range,
			diagnostics,
			...(input.only ? { only: input.only } : {}),
			maxActions: input.maxActions,
			timeoutMs: input.deadlineMs,
		});
		const actions: CodeActionPreview[] = [];
		const responseBase = { actions, truncated: false, deadlineReached: false, provenance: index.provenance };
		if (byteSize(responseBase) > input.maxBytes) throw new InvalidCodeActionRequest("maxBytes is too small for the response envelope");
		let truncated = candidates.length > input.maxActions;
		this.prune();
		for (const candidate of candidates.slice(0, input.maxActions)) {
			if (this.now() >= deadlineAt) break;
			const remainingMs = Math.max(1, deadlineAt - this.now());
			const action = !candidate.edit && index.resolveCodeAction ? await index.resolveCodeAction(candidate, remainingMs) : candidate;
			if (!action.edit && action.command && !input.includeCommandActions) continue;
			const paths = action.edit ? collectTouchedPaths(action.edit) : [];
			if (paths.length > input.maxFiles || (action.edit && editCount(action.edit) > input.maxEdits)) {
				truncated = true;
				continue;
			}
			for (const path of paths) entry.port.resolvePath(path);
			const id = codeActionPreviewId(randomUUID());
			const preview: CodeActionPreview = {
				id,
				title: action.title,
				...(action.kind ? { kind: action.kind } : {}),
				preferred: action.preferred,
				...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
				affectedPaths: paths,
				...(action.edit ? { edit: action.edit } : {}),
				...(action.command ? { command: { title: action.command.title, command: action.command.command } } : {}),
			};
			if (byteSize({ ...responseBase, actions: [...actions, preview] }) > input.maxBytes) {
				truncated = true;
				break;
			}
			const expectedHashes = new Map<string, ContentHash | null>();
			for (const path of paths) {
				const read = await entry.port.readEntry(path);
				const hash = read.exists ? contentHashOf(read.content) : null;
				if (path === sourcePath && hash !== sourceHash) throw new StaleExpectedHash(path, sourceHash, hash);
				expectedHashes.set(path, hash);
			}
			const storedAction: SemanticCodeAction = {
				path: action.path,
				title: action.title,
				...(action.kind ? { kind: action.kind } : {}),
				preferred: action.preferred,
				...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
				diagnostics: [],
				...(action.edit ? { edit: action.edit } : {}),
				...(action.command ? { command: { title: action.command.title, command: action.command.command } } : {}),
			};
			this.prune();
			this.previews.set(id, { workspaceId: input.workspaceId, action: storedAction, expectedHashes, createdAt: this.now() });
			actions.push(preview);
		}
		const deadlineReached = this.now() >= deadlineAt;
		return { actions, truncated: truncated || deadlineReached, deadlineReached, provenance: index.provenance };
	}

	private async apply(input: OperationInputs["workspace.applyCodeAction"]): Promise<OperationOutputs["workspace.applyCodeAction"]> {
		this.prune();
		const stored = this.previews.get(input.previewId);
		if (!stored || stored.workspaceId !== input.workspaceId) throw new CodeActionPreviewUnavailable(input.previewId);
		if (stored.action.disabledReason) throw new DisabledCodeAction(input.previewId, stored.action.disabledReason);
		if (stored.action.command && !stored.action.edit) throw new CodeActionCommandDenied(input.previewId);
		if (!stored.action.edit) throw new CodeActionPreviewUnavailable(input.previewId);
		const edit = stored.action.edit;
		const entry = this.deps.registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		return this.deps.mutationBarrier.run(input.workspaceId, async () => {
			await using lease = await requireCodeIntelligence(this.deps.warmIndexes, { workspaceId: input.workspaceId, path: stored.action.path });
			const { index } = lease.value;
			for (const operation of edit.operations) {
				if (operation.kind !== "text" || operation.version === undefined || operation.version === null) continue;
				const actual = index.documentVersion?.(operation.path);
				if (actual !== operation.version) throw new StaleCodeActionDocumentVersion(operation.path, operation.version, actual);
			}
			const changedPaths = collectTouchedPaths(edit);
			const affectedPaths = this.deps.diagnosticValidation
				? await this.deps.diagnosticValidation.affectedPaths(input.workspaceId, changedPaths, 2, 500, 5_000)
				: [];
			const baseline = this.deps.diagnosticValidation ? await this.deps.diagnosticValidation.capture(input.workspaceId, affectedPaths, 30_000) : undefined;
			const fileOperations = fileOperationParts(edit);
			await index.notifyFilesWillRename?.(fileOperations.renamePairs);
			await index.notifyFilesWillCreate?.(fileOperations.createPaths);
			await index.notifyFilesWillDelete?.(fileOperations.deletePaths);
			const outcome = await applyWorkspaceEdit(entry.port, edit, stored.expectedHashes);
			index.notifyFilesDidRename?.(fileOperations.renamePairs);
			index.notifyFilesDidCreate?.(fileOperations.createPaths);
			index.notifyFilesDidDelete?.(fileOperations.deletePaths);
			const transactionId = outcome.steps.length
				? await this.deps.mutationHistory.recordTransaction(input.workspaceId, "code-action", outcome.steps)
				: undefined;
			if (this.deps.diagnosticValidation && baseline && transactionId) {
				const after = await this.deps.diagnosticValidation.capture(input.workspaceId, affectedPaths, 30_000);
				this.deps.diagnosticValidation.record(transactionId, baseline, after);
			}
			this.previews.delete(input.previewId);
			return {
				touchedPaths: outcome.touchedPaths,
				...(transactionId ? { transactionId } : {}),
				...(stored.action.command ? { pendingCommand: { title: stored.action.command.title, command: stored.action.command.command } } : {}),
				provenance: index.provenance,
			};
		});
	}
}
