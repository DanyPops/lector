import { createTwoFilesPatch } from "diff";
import type { SymbolDeclarationSnapshot } from "./symbol-declaration-snapshot.ts";

export type SymbolComparisonStatus = "unchanged" | "changed" | "added" | "removed" | "both-missing";

export interface SymbolDeclarationComparison {
	readonly status: SymbolComparisonStatus;
	/** Real unified-diff text (git-diff/Malevich renderDiffLines compatible), "" for unchanged/both-missing. */
	readonly diff: string;
	readonly truncated: boolean;
}

/**
 * Compares one symbol's own declaration text between two already-extracted snapshots -- pure,
 * no git or tree-sitter I/O here (see LocalGit.showFile and the tree-sitter declaration-text
 * adapter for where each snapshot's content actually comes from). Missing-on-both-sides is its
 * own status, distinct from "unchanged", since there is no declaration text to have stayed the
 * same -- reporting "unchanged" there would misleadingly imply the symbol exists at all.
 */
export function compareSymbolDeclarations(
	path: string,
	symbolName: string,
	fromLabel: string,
	toLabel: string,
	from: SymbolDeclarationSnapshot,
	to: SymbolDeclarationSnapshot,
	maxBytes: number,
): SymbolDeclarationComparison {
	if (!from.found && !to.found) return { status: "both-missing", diff: "", truncated: false };
	if (from.found && to.found && from.text === to.text) return { status: "unchanged", diff: "", truncated: false };

	const status: SymbolComparisonStatus = from.found && to.found ? "changed" : from.found ? "removed" : "added";
	const label = `${path} (${symbolName})`;
	const raw = createTwoFilesPatch(`${label} @ ${fromLabel}`, `${label} @ ${toLabel}`, from.text ?? "", to.text ?? "");
	const truncated = raw.length > maxBytes;
	return { status, diff: truncated ? raw.slice(0, maxBytes) : raw, truncated };
}
