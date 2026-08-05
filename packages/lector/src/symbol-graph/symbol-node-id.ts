import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";

/**
 * A symbol graph node's identity: deterministic from its own declaration
 * location, so the same declaration always maps to the same node across
 * separate indexing passes -- never a random/incrementing id that would
 * make two passes over the same unchanged code disagree with each other.
 * Branded so a raw string (a path, a workspace id, any other identifier in
 * scope) can never be passed where a real node id is required -- this exact
 * `path:line:character` format is an internal implementation detail no
 * caller should construct by hand.
 */
export type SymbolNodeId = string & { readonly __brand: "SymbolNodeId" };

export function deriveSymbolNodeId(location: WorkspaceLocation): SymbolNodeId {
	// The one place SymbolNodeId is minted from a plain string -- the brand exists precisely so
	// nowhere else can.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return `${location.path}:${location.line}:${location.character}` as SymbolNodeId;
}
