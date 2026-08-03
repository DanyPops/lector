import type { FileTreeEntryKind } from "@danypops/lector";

/** One entry as last known from a real directory listing -- id is this explorer's own per-session identity, not anything Lector's daemon tracks. */
export interface ExplorerEntry {
	readonly id: number;
	readonly name: string;
	readonly kind: FileTreeEntryKind;
}

/** One buffer line, parsed back into its id (if any) and name. */
export interface ParsedExplorerLine {
	readonly id: number | null;
	readonly name: string;
	readonly isDirectory: boolean;
}

export type ExplorerDiff =
	| { readonly kind: "create"; readonly name: string; readonly isDirectory: boolean }
	| { readonly kind: "rename"; readonly id: number; readonly fromName: string; readonly toName: string }
	| { readonly kind: "delete"; readonly id: number; readonly name: string; readonly isDirectory: boolean };

/** Renders one entry as this explorer's own line format: "<id> name", a trailing "/" for directories. Ported from oil.nvim's own id-prefix convention (lua/oil/mutator/parser.lua) -- this terminal has no Neovim conceallevel equivalent, so the id is real, visible (if dimly styled) text, not truly hidden. */
export function formatExplorerLine(entry: ExplorerEntry): string {
	return `${entry.id} ${entry.name}${entry.kind === "directory" ? "/" : ""}`;
}

const EXISTING_LINE_PATTERN = /^(\d+) (.+)$/;

function stripTrailingSlash(name: string): { name: string; isDirectory: boolean } {
	return name.endsWith("/") ? { name: name.slice(0, -1), isDirectory: true } : { name, isDirectory: false };
}

/** Parses one buffer line back into id/name/isDirectory. Returns null for a blank line -- ignored entirely, never a new entry named "". */
export function parseExplorerLine(rawLine: string): ParsedExplorerLine | null {
	const trimmed = rawLine.trim();
	if (trimmed === "") return null;

	const existingMatch = trimmed.match(EXISTING_LINE_PATTERN);
	if (existingMatch) {
		const idText = existingMatch[1];
		const rest = existingMatch[2];
		if (idText === undefined || rest === undefined) return null;
		const { name, isDirectory } = stripTrailingSlash(rest.trim());
		return { id: Number(idText), name, isDirectory };
	}

	const { name, isDirectory } = stripTrailingSlash(trimmed);
	return { id: null, name, isDirectory };
}

/**
 * Diffs the explorer's current buffer lines against the original listing, matched by id -- never
 * by line position, so reordering existing lines produces no diff at all. Every original entry
 * not re-seen by its own id becomes a delete; every id-tagged line whose name changed becomes a
 * rename; every line with no id tag becomes a create.
 */
export function diffExplorerLines(original: readonly ExplorerEntry[], currentLines: readonly string[]): ExplorerDiff[] {
	const byId = new Map(original.map((entry) => [entry.id, entry]));
	const unseenIds = new Set(byId.keys());
	const diffs: ExplorerDiff[] = [];

	for (const rawLine of currentLines) {
		const parsed = parseExplorerLine(rawLine);
		if (!parsed) continue;

		if (parsed.id === null) {
			diffs.push({ kind: "create", name: parsed.name, isDirectory: parsed.isDirectory });
			continue;
		}

		const originalEntry = byId.get(parsed.id);
		unseenIds.delete(parsed.id);
		if (!originalEntry) continue; // an id that doesn't match anything real -- silently ignored, same as a stray line would be
		if (originalEntry.name !== parsed.name) {
			diffs.push({ kind: "rename", id: parsed.id, fromName: originalEntry.name, toName: parsed.name });
		}
	}

	for (const id of unseenIds) {
		const entry = byId.get(id);
		if (entry) diffs.push({ kind: "delete", id: entry.id, name: entry.name, isDirectory: entry.kind === "directory" });
	}

	return diffs;
}
