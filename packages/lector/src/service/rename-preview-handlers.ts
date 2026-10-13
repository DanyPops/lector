import { randomUUID } from "node:crypto";
import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import { contentHashOf } from "../content-identity/content-hash.ts";
import { StaleExpectedHash } from "../workspace/exact-edit.ts";
import {
	applyMutationPlan,
	type ContentFormatter,
	FormatterUnavailable,
	type MutationPlan,
	MutationPlanLimitExceeded,
	previewMutationPlan,
} from "../workspace/mutation-plan.ts";
import { WorkspaceEntryNotFound } from "../workspace/raw-read.ts";
import type { ParsedWorkspaceEdit } from "../workspace/workspace-edit.ts";
import { requireCodeIntelligence } from "./code-intelligence-handlers.ts";
import { RenameNotSupported, UnknownWorkspace, type WorkspaceId } from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { referenceRenamePlan } from "./symbol-graph/reference-rename-plan.ts";
import type { RenameHandlerDeps } from "./symbol-graph/rename-handlers.ts";

export interface RenamePreview extends MutationPlan {
	readonly id: string;
	readonly kind: "symbol" | "file";
	readonly affectedPaths: readonly string[];
	readonly edit: ParsedWorkspaceEdit;
	readonly expiresAt: number;
	readonly caveats: readonly string[];
	readonly provenance?: IntelligenceProvenance;
	readonly coverage?: {
		readonly status: "cached";
		readonly maxFiles: number;
		readonly maxSymbolsPerFile: number;
		readonly sourceFingerprint: string;
		readonly completedAt: number;
	};
}

interface StoredPreview {
	readonly workspaceId: WorkspaceId;
	readonly sourcePath: string;
	readonly preview: RenamePreview;
}

export class RenamePreviewUnavailable extends Error {
	constructor() {
		super("Rename preview is unknown, expired, consumed or belongs to another workspace");
		this.name = "RenamePreviewUnavailable";
	}
}

export class RenamePreviewHandlers {
	private readonly previews = new Map<string, StoredPreview>();
	private readonly now: () => number;

	constructor(private readonly deps: RenameHandlerDeps & { formatContent?: ContentFormatter; now?: () => number }) {
		this.now = deps.now ?? Date.now;
	}

	readonly handlers = {
		"workspace.previewRename": async (_registry: unknown, input: OperationInputs["workspace.previewRename"]): Promise<RenamePreview> => {
			const entry = this.deps.registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			const sourcePath = entry.port.resolvePath(input.path);
			const before = await entry.port.readEntry(sourcePath);
			if (!before.exists) throw new WorkspaceEntryNotFound(sourcePath);
			await using lease = await requireCodeIntelligence(this.deps.warmIndexes, { workspaceId: input.workspaceId, path: sourcePath });
			if (!lease.value.index.rename) throw new RenameNotSupported(input.workspaceId);
			const edit = await lease.value.index.rename({ path: sourcePath, line: input.line, character: input.character }, input.newName);
			const plan = await this.project(input.workspaceId, edit, input, input.format);
			const after = await entry.port.readEntry(sourcePath);
			const actual = after.exists ? contentHashOf(after.content) : null;
			if (actual !== contentHashOf(before.content)) throw new StaleExpectedHash(sourcePath, contentHashOf(before.content), actual);
			return this.retain(
				input.workspaceId,
				sourcePath,
				{
					...plan,
					guards: plan.guards.some((guard) => guard.path === sourcePath)
						? plan.guards
						: [...plan.guards, { path: sourcePath, expectedHash: contentHashOf(before.content) }],
					id: randomUUID(),
					kind: "symbol",
					edit,
					affectedPaths: plan.files.map((file) => file.path),
					expiresAt: this.now() + 600_000,
					caveats: [],
					provenance: lease.value.index.provenance,
				},
				input.maxBytes,
			);
		},
		"workspace.previewFileMove": async (_registry: unknown, input: OperationInputs["workspace.previewFileMove"]): Promise<RenamePreview> => {
			const entry = this.deps.registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
			const generation = await this.deps.cacheStatus(this.deps.registry, input);
			if (generation.status !== "cached" || !generation.generation.sourceFingerprint || generation.generation.result.sourceCoverage?.truncated)
				throw new RenamePreviewUnavailable();
			const reference = await referenceRenamePlan(this.deps, this.deps.registry, { ...input, autoPopulate: false });
			const operations: ParsedWorkspaceEdit["operations"][number][] = [
				{ kind: "create", path: reference.move.toPath, overwrite: false, ignoreIfExists: false },
				{
					kind: "text",
					path: reference.move.toPath,
					edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: reference.move.content }],
				},
			];
			for (const rewrite of reference.importRewrites) {
				const before = await entry.port.readEntry(rewrite.path);
				const actual = before.exists ? contentHashOf(before.content) : null;
				if (actual !== rewrite.expectedHash || !before.exists) throw new StaleExpectedHash(rewrite.path, rewrite.expectedHash, actual);
				const lines = before.content.split("\n");
				operations.push({
					kind: "text",
					path: rewrite.path,
					edits: [
						{
							range: { start: { line: 1, character: 1 }, end: { line: lines.length, character: (lines.at(-1)?.length ?? 0) + 1 } },
							newText: rewrite.newContent,
						},
					],
				});
			}
			operations.push({ kind: "delete", path: reference.move.fromPath, recursive: false, ignoreIfNotExists: false });
			const edit = { operations };
			const plan = await this.project(input.workspaceId, edit, { ...input, maxFiles: input.maxAffectedFiles }, input.format);
			const source = plan.files.find((file) => file.path === reference.move.fromPath);
			if (source?.expectedHash !== reference.move.expectedHash)
				throw new StaleExpectedHash(reference.move.fromPath, reference.move.expectedHash, source?.expectedHash ?? null);
			for (const rewrite of reference.importRewrites) {
				const file = plan.files.find((file) => file.path === rewrite.path);
				if (file?.expectedHash !== rewrite.expectedHash) throw new StaleExpectedHash(rewrite.path, rewrite.expectedHash, file?.expectedHash ?? null);
			}
			return this.retain(
				input.workspaceId,
				reference.move.fromPath,
				{
					...plan,
					id: randomUUID(),
					kind: "file",
					edit,
					affectedPaths: plan.files.map((file) => file.path),
					expiresAt: this.now() + 600_000,
					caveats: reference.caveats,
					coverage: {
						status: "cached",
						maxFiles: input.maxFiles,
						maxSymbolsPerFile: input.maxSymbolsPerFile,
						sourceFingerprint: generation.generation.sourceFingerprint,
						completedAt: generation.generation.completedAt,
					},
				},
				input.maxBytes,
			);
		},
		"workspace.applyRenamePreview": async (
			_registry: unknown,
			input: OperationInputs["workspace.applyRenamePreview"],
		): Promise<OperationOutputs["workspace.applyRenamePreview"]> => {
			const stored = this.previews.get(input.previewId);
			if (!stored || stored.workspaceId !== input.workspaceId || stored.preview.expiresAt <= this.now()) throw new RenamePreviewUnavailable();
			return this.deps.renameMutationBarrier.run(input.workspaceId, async () => {
				if (this.previews.get(input.previewId) !== stored || stored.preview.expiresAt <= this.now()) throw new RenamePreviewUnavailable();
				this.previews.delete(input.previewId);
				const entry = this.deps.registry.get(input.workspaceId);
				if (!entry) throw new UnknownWorkspace(input.workspaceId);
				await using lease = await requireCodeIntelligence(this.deps.warmIndexes, { workspaceId: input.workspaceId, path: stored.sourcePath });
				const { index } = lease.value;
				if (stored.preview.coverage) {
					const status = await this.deps.cacheStatus(this.deps.registry, { workspaceId: input.workspaceId, ...stored.preview.coverage });
					if (
						status.status !== "cached" ||
						status.generation.sourceFingerprint !== stored.preview.coverage.sourceFingerprint ||
						status.generation.completedAt !== stored.preview.coverage.completedAt ||
						status.generation.result.sourceCoverage?.truncated
					)
						throw new RenamePreviewUnavailable();
				}
				for (const operation of stored.preview.edit.operations) {
					if (operation.kind !== "text" || operation.version === undefined || operation.version === null) continue;
					const version = index.documentVersion?.(operation.path);
					if (version !== operation.version) throw new RenamePreviewUnavailable();
				}
				const paths = stored.preview.affectedPaths;
				const affected = this.deps.diagnosticValidation ? await this.deps.diagnosticValidation.affectedPaths(input.workspaceId, paths, 2, 500, 5000) : [];
				const before = this.deps.diagnosticValidation ? await this.deps.diagnosticValidation.capture(input.workspaceId, affected, 30_000) : undefined;
				const outcome = await applyMutationPlan(entry.port, stored.preview);
				const renames = stored.preview.edit.operations
					.filter((operation) => operation.kind === "rename")
					.map((operation) => ({ fromPath: operation.fromPath, toPath: operation.toPath }));
				index.notifyFilesDidRename?.(renames);
				index.notifyFilesDidCreate?.(stored.preview.edit.operations.filter((operation) => operation.kind === "create").map((operation) => operation.path));
				index.notifyFilesDidDelete?.(stored.preview.edit.operations.filter((operation) => operation.kind === "delete").map((operation) => operation.path));
				const transactionId = await this.deps.mutationHistory.recordTransaction(input.workspaceId, "rename", outcome.steps);
				if (this.deps.diagnosticValidation && before) {
					const after = await this.deps.diagnosticValidation.capture(input.workspaceId, affected, 30_000);
					this.deps.diagnosticValidation.record(transactionId, before, after);
				}
				return { touchedPaths: outcome.touchedPaths, transactionId, formatted: stored.preview.formatted };
			});
		},
	};

	private async project(
		workspaceId: WorkspaceId,
		edit: ParsedWorkspaceEdit,
		bounds: { maxFiles: number; maxEdits: number; maxBytes: number },
		format?: boolean,
	): Promise<MutationPlan> {
		if (format && !this.deps.formatContent) throw new FormatterUnavailable();
		const entry = this.deps.registry.get(workspaceId);
		if (!entry) throw new UnknownWorkspace(workspaceId);
		return previewMutationPlan(entry.port, edit, bounds, format ? this.deps.formatContent : undefined);
	}

	private retain(workspaceId: WorkspaceId, sourcePath: string, preview: RenamePreview, maxBytes: number): RenamePreview {
		if (!preview.files.length || Buffer.byteLength(JSON.stringify(preview)) > maxBytes) throw new MutationPlanLimitExceeded();
		for (const [id, stored] of this.previews) if (stored.preview.expiresAt <= this.now()) this.previews.delete(id);
		if (this.previews.size >= 128) {
			const oldest = this.previews.keys().next().value;
			if (oldest !== undefined) this.previews.delete(oldest);
		}
		this.previews.set(preview.id, { workspaceId, sourcePath, preview: structuredClone(preview) });
		return structuredClone(preview);
	}
}
