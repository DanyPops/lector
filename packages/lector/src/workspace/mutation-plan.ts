import { createTwoFilesPatch } from "diff";
import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { type ApplyWorkspaceEditOutcome, applyWorkspaceEdit, collectTouchedPaths } from "./apply-workspace-edit.ts";
import { StaleExpectedHash } from "./exact-edit.ts";
import { InMemoryWorkspace } from "./in-memory-workspace.ts";
import type { WorkspacePort } from "./port.ts";
import { retainBom } from "./text-bytes.ts";
import type { ParsedWorkspaceEdit } from "./workspace-edit.ts";

export type ContentFormatter = (path: string, content: string) => Promise<string>;

export interface MutationFileChange {
	readonly path: string;
	readonly expectedHash: ContentHash | null;
	readonly beforeContent: string | null;
	readonly afterContent: string | null;
	readonly patch: string;
}

export interface MutationPlan {
	readonly guards: readonly { readonly path: string; readonly expectedHash: ContentHash | null }[];
	readonly files: readonly MutationFileChange[];
	readonly formatted: boolean;
}

export class MutationPlanLimitExceeded extends Error {
	constructor() {
		super("Mutation plan exceeds its file, edit or byte bounds; nothing was written");
		this.name = "MutationPlanLimitExceeded";
	}
}

export class FormatterUnavailable extends Error {
	constructor() {
		super("Formatting was requested but no host-owned content formatter is configured");
		this.name = "FormatterUnavailable";
	}
}

export class MutationRollbackIncomplete extends Error {
	constructor(
		readonly paths: readonly string[],
		cause: unknown,
	) {
		super(`Mutation failed and rollback was incomplete for: ${paths.join(", ")}`, { cause });
		this.name = "MutationRollbackIncomplete";
	}
}

export async function previewMutationPlan(
	workspace: WorkspacePort,
	edit: ParsedWorkspaceEdit,
	bounds: { maxFiles: number; maxEdits: number; maxBytes: number },
	formatter?: ContentFormatter,
): Promise<MutationPlan> {
	const paths = collectTouchedPaths(edit);
	const edits = edit.operations.reduce((count, operation) => count + (operation.kind === "text" ? operation.edits.length : 1), 0);
	if (paths.length > bounds.maxFiles || edits > bounds.maxEdits) throw new MutationPlanLimitExceeded();
	const projected = new InMemoryWorkspace();
	const before = new Map<string, string | null>();
	const hashes = new Map<string, ContentHash | null>();
	let bytes = 0;
	for (const path of paths) {
		const resolved = workspace.resolvePath(path);
		if (resolved !== path) throw new Error("Mutation preview paths must use canonical workspace identities");
		const entry = await workspace.readEntry(path);
		const content = entry.exists ? entry.content : null;
		bytes += content === null ? 0 : Buffer.byteLength(content);
		if (bytes > bounds.maxBytes) throw new MutationPlanLimitExceeded();
		before.set(path, content);
		hashes.set(path, content === null ? null : contentHashOf(content));
		if (content !== null) await projected.writeEntry(path, null, content);
	}
	await applyWorkspaceEdit(projected, edit, hashes);
	const files: MutationFileChange[] = [];
	for (const path of paths) {
		const entry = await projected.readEntry(path);
		let afterContent = entry.exists ? entry.content : null;
		if (afterContent !== null && formatter) afterContent = retainBom(afterContent, await formatter(path, afterContent));
		if (afterContent !== null && Buffer.byteLength(afterContent) > bounds.maxBytes) throw new MutationPlanLimitExceeded();
		const beforeContent = before.get(path) ?? null;
		if (beforeContent === afterContent) continue;
		files.push({
			path,
			expectedHash: hashes.get(path) ?? null,
			beforeContent,
			afterContent,
			patch: createTwoFilesPatch(path, path, beforeContent ?? "", afterContent ?? ""),
		});
	}
	const plan = { files, guards: [...hashes].map(([path, expectedHash]) => ({ path, expectedHash })), formatted: !!formatter };
	if (Buffer.byteLength(JSON.stringify(plan)) > bounds.maxBytes) throw new MutationPlanLimitExceeded();
	return plan;
}

export async function applyMutationPlan(workspace: WorkspacePort, plan: MutationPlan): Promise<ApplyWorkspaceEditOutcome> {
	for (const file of plan.guards) {
		const entry = await workspace.readEntry(file.path);
		const hash = entry.exists ? contentHashOf(entry.content) : null;
		if (hash !== file.expectedHash) throw new StaleExpectedHash(file.path, file.expectedHash, hash);
	}
	const steps: Array<{ path: string; beforeContent: string | null; afterHash: ContentHash | null }> = [];
	try {
		const files = [...plan.files.filter((file) => file.afterContent !== null), ...plan.files.filter((file) => file.afterContent === null)];
		for (const file of files) {
			if (file.afterContent === null) {
				if (file.expectedHash === null) throw new Error("Cannot delete a path absent at preview");
				await workspace.deleteEntry(file.path, file.expectedHash);
				steps.push({ path: file.path, beforeContent: file.beforeContent, afterHash: null });
			} else {
				const written = await workspace.writeEntry(file.path, file.expectedHash, file.afterContent);
				steps.push({ path: file.path, beforeContent: file.beforeContent, afterHash: written.newHash });
			}
		}
		return { touchedPaths: steps.map((step) => step.path), steps };
	} catch (error) {
		const failed: string[] = [];
		for (const step of [...steps].reverse()) {
			try {
				if (step.beforeContent === null) {
					if (step.afterHash !== null) await workspace.deleteEntry(step.path, step.afterHash);
				} else await workspace.writeEntry(step.path, step.afterHash, step.beforeContent);
			} catch {
				failed.push(step.path);
			}
		}
		if (failed.length) throw new MutationRollbackIncomplete(failed, error);
		throw error;
	}
}
