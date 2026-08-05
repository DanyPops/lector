import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import type { WorkspacePort } from "../ports/workspace-port.ts";
import type { SymbolGraphPort } from "../symbol-graph/port.ts";
import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import type { SymbolAnnotation } from "./symbol-annotation.ts";
import { type AnchorReality, isAnnotationStale } from "./symbol-annotation-staleness.ts";

/**
 * Resolves every anchor's current reality against the live graph and
 * workspace, then applies the pure staleness decision. One workspace read
 * per distinct anchored file, not per anchor -- an annotation anchoring
 * several symbols in the same file reads that file once.
 */
export async function checkAnnotationStaleness(graph: SymbolGraphPort, workspace: WorkspacePort, annotation: SymbolAnnotation): Promise<boolean> {
	const hashByPath = new Map<string, ContentHash | undefined>();
	const realityByAnchor = new Map<SymbolNodeId, AnchorReality>();

	for (const anchor of annotation.anchors) {
		const node = await graph.getNode(anchor.symbolNodeId);
		if (!node) {
			realityByAnchor.set(anchor.symbolNodeId, { exists: false, currentFileHash: undefined });
			continue;
		}
		if (!hashByPath.has(anchor.path)) {
			const entry = await workspace.readEntry(anchor.path);
			hashByPath.set(anchor.path, entry.exists ? contentHashOf(entry.content) : undefined);
		}
		realityByAnchor.set(anchor.symbolNodeId, { exists: true, currentFileHash: hashByPath.get(anchor.path) });
	}

	return isAnnotationStale(annotation.anchors, realityByAnchor);
}
