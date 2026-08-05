import type { SymbolEdgeRecord, SymbolNode } from "./port.ts";

/**
 * A changed file's declarations may shift position (line/character), changing their node ids.
 * Any other file with an edge pointing at one of those (now-stale) ids must be re-walked too, or
 * its own outgoing edge into the changed file is silently lost (removeNodesForFile cascades the
 * delete) rather than re-pointed at the new id. Returns only direct referrers: a file's own
 * declaration positions never move because of another file's edit, so one hop is sufficient --
 * no transitive cascade is possible.
 */
export function findDependentFiles(nodes: readonly SymbolNode[], edges: readonly SymbolEdgeRecord[], changedFiles: ReadonlySet<string>): ReadonlySet<string> {
	const pathById = new Map<string, string>();
	for (const node of nodes) pathById.set(node.id, node.location.path);

	const changedNodeIds = new Set<string>();
	for (const node of nodes) if (changedFiles.has(node.location.path)) changedNodeIds.add(node.id);

	const dependents = new Set<string>();
	for (const edge of edges) {
		if (!changedNodeIds.has(edge.to)) continue;
		const fromPath = pathById.get(edge.from);
		if (fromPath && !changedFiles.has(fromPath)) dependents.add(fromPath);
	}
	return dependents;
}
