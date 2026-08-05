import type { ContentHash } from "../content-identity/content-hash.ts";
import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import type { SymbolAnnotationAnchor } from "./symbol-annotation.ts";

/**
 * What's currently true about one anchor, resolved live against the graph
 * and workspace -- resolved once per anchor by the caller, so the pure
 * decision below never calls a port itself.
 */
export interface AnchorReality {
	readonly exists: boolean;
	readonly currentFileHash: ContentHash | undefined;
}

/**
 * An annotation is stale the moment any single anchor no longer holds: the
 * symbol node was renamed, deleted, or shifted (existence check), or its
 * file's content changed since this anchor was recorded (content-hash
 * check). Either is sufficient -- a narrative anchored to N symbols is only
 * as trustworthy as its least-current anchor. Deliberately file-level, not
 * anchor-line-level: an unrelated edit elsewhere in the same file also
 * marks it stale. Coarse but honest; never a false "still fresh".
 */
export function isAnnotationStale(anchors: readonly SymbolAnnotationAnchor[], realityByAnchor: ReadonlyMap<SymbolNodeId, AnchorReality>): boolean {
	for (const anchor of anchors) {
		const reality = realityByAnchor.get(anchor.symbolNodeId);
		if (!reality?.exists) return true;
		if (reality.currentFileHash !== anchor.fileContentHash) return true;
	}
	return false;
}
