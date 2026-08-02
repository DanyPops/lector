import type { WorkspaceLocation } from "../domain/workspace-symbol.ts";

/**
 * A symbol graph node's identity: deterministic from its own declaration
 * location, so the same declaration always maps to the same node across
 * separate indexing passes -- never a random/incrementing id that would
 * make two passes over the same unchanged code disagree with each other.
 */
export type SymbolNodeId = string;

export function deriveSymbolNodeId(location: WorkspaceLocation): SymbolNodeId {
	return `${location.path}:${location.line}:${location.character}`;
}
