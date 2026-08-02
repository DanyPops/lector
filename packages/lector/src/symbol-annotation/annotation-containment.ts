import type { AnnotationId, SymbolAnnotation } from "./symbol-annotation.ts";

/** The minimal read surface a containment traversal needs -- satisfied by SymbolAnnotationPort itself. */
export interface ContainmentReader {
	children(parentId: AnnotationId): Promise<readonly AnnotationId[]>;
	get(id: AnnotationId): Promise<SymbolAnnotation | undefined>;
}

const DEFAULT_MAX_TRAVERSED = 10_000;

/**
 * True if adding a parentId -> childId containment edge would create a cycle: a direct
 * self-loop, or childId can already reach parentId via existing contains edges. A bounded BFS,
 * not unbounded -- a real containment graph is small (agent-authored, not automatically
 * expanding), but this never trusts that assumption blindly.
 *
 * Deliberately implemented once here over the single-hop children() primitive, shared by both
 * adapters, rather than duplicated per-adapter the way SymbolGraphPort.reachableFrom is: unlike
 * the symbol graph (which needs edge-kind filtering and each adapter's own efficient bulk-query
 * mechanism -- graphology's BFS vs a SQL recursive CTE), containment is one relation kind over a
 * small expected node count, so one shared traversal is simpler and avoids drift between adapters.
 */
export async function wouldCreateContainmentCycle(
	reader: Pick<ContainmentReader, "children">,
	parentId: AnnotationId,
	childId: AnnotationId,
	maxTraversed = DEFAULT_MAX_TRAVERSED,
): Promise<boolean> {
	if (parentId === childId) return true;
	const visited = new Set<AnnotationId>([childId]);
	let frontier: AnnotationId[] = [childId];
	while (frontier.length > 0 && visited.size < maxTraversed) {
		const next: AnnotationId[] = [];
		for (const id of frontier) {
			for (const kid of await reader.children(id)) {
				if (kid === parentId) return true;
				if (!visited.has(kid)) {
					visited.add(kid);
					next.push(kid);
				}
			}
		}
		frontier = next;
	}
	return false;
}

/**
 * Every annotation reachable via contains edges from rootId (including rootId itself), up to
 * maxDepth hops, BFS order. An id the store no longer has a record for (deleted since the edge
 * was recorded) is dropped, not fabricated -- same discipline as reachableSymbolsFrom for the
 * symbol graph. rootId not existing at all yields an empty result, not an error, matching get()'s
 * own "undefined means not found" convention rather than throwing.
 */
export async function annotationsContainedFrom(reader: ContainmentReader, rootId: AnnotationId, maxDepth: number): Promise<SymbolAnnotation[]> {
	const root = await reader.get(rootId);
	if (!root) return [];
	const results: SymbolAnnotation[] = [root];
	const visited = new Set<AnnotationId>([rootId]);
	let frontier: AnnotationId[] = [rootId];
	for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
		const next: AnnotationId[] = [];
		for (const id of frontier) {
			for (const childId of await reader.children(id)) {
				if (visited.has(childId)) continue;
				visited.add(childId);
				const child = await reader.get(childId);
				if (child) {
					results.push(child);
					next.push(childId);
				}
			}
		}
		frontier = next;
	}
	return results;
}
