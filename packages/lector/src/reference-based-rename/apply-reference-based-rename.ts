import type { ContentHash } from "../content-identity/content-hash.ts";
import type { WorkspacePort } from "../workspace/port.ts";
import type { ReferenceBasedRenamePlan } from "./reference-based-rename.ts";

export interface ReferenceBasedRenameOutcome {
	readonly movedTo: string;
	readonly filesUpdated: readonly string[];
	readonly caveats: readonly string[];
}

interface AppliedStep {
	readonly path: string;
	/** How to undo this step: write this exact content back (null means "delete it"), guarded by the hash this step's own write/delete just produced. */
	readonly undoContent: string | null;
	readonly currentHash: ContentHash;
}

/**
 * Applies a ReferenceBasedRenamePlan all-or-nothing: creates the file at its new path, rewrites
 * every referencing file, then deletes the old path -- in that order, so a failure at any point
 * rolls back every step already applied (reverse order) before rethrowing, leaving the whole
 * tree exactly as it was. Delete-last is deliberate: if it's the step that fails, nothing else
 * needs undoing except the earlier successful steps, since a failed writeEntry/deleteEntry never
 * partially mutates anything by the port's own contract.
 */
export async function applyReferenceBasedRename(workspace: WorkspacePort, plan: ReferenceBasedRenamePlan): Promise<ReferenceBasedRenameOutcome> {
	const applied: AppliedStep[] = [];

	async function rollback(): Promise<void> {
		for (const step of [...applied].reverse()) {
			if (step.undoContent === null) {
				await workspace.deleteEntry(step.path, step.currentHash);
			} else {
				await workspace.writeEntry(step.path, step.currentHash, step.undoContent);
			}
		}
	}

	try {
		const created = await workspace.writeEntry(plan.move.toPath, null, plan.move.content);
		// Undoing a creation means deleting it -- undoContent: null.
		applied.push({ path: plan.move.toPath, undoContent: null, currentHash: created.newHash });

		for (const rewrite of plan.importRewrites) {
			const before = await workspace.readEntry(rewrite.path);
			const originalContent = before.exists ? before.content : null;
			const written = await workspace.writeEntry(rewrite.path, rewrite.expectedHash, rewrite.newContent);
			applied.push({ path: rewrite.path, undoContent: originalContent, currentHash: written.newHash });
		}

		await workspace.deleteEntry(plan.move.fromPath, plan.move.expectedHash);

		return { movedTo: plan.move.toPath, filesUpdated: plan.importRewrites.map((rewrite) => rewrite.path), caveats: plan.caveats };
	} catch (error) {
		await rollback();
		throw error;
	}
}
