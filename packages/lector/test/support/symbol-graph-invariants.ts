/**
 * Structural invariants any populated SymbolGraphPort must hold, regardless
 * of which language or descriptor produced it: no edge may point at a node
 * outside the known set, no node may point at itself, and only a callable
 * symbol (function/method/constructor) may have an outgoing "calls" edge.
 */
import type { SymbolEdgeKind, SymbolGraphPort } from "../../src/symbol-graph/port.ts";
import type { SymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

const EDGE_KINDS: readonly SymbolEdgeKind[] = ["calls", "contains", "references"];
const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);

export interface SymbolGraphInvariantViolation {
	readonly rule: "dangling-edge" | "self-loop" | "non-callable-calls-source";
	readonly detail: string;
}

/** Checks every known node's outgoing edges against the invariants above. `nodeIds` is the full known set -- an edge pointing outside it is dangling. */
export async function findSymbolGraphInvariantViolations(graph: SymbolGraphPort, nodeIds: readonly SymbolNodeId[]): Promise<SymbolGraphInvariantViolation[]> {
	const knownIds = new Set(nodeIds);
	const violations: SymbolGraphInvariantViolation[] = [];

	for (const id of nodeIds) {
		const node = await graph.getNode(id);
		for (const kind of EDGE_KINDS) {
			const targets = await graph.edgesFrom(id, kind);
			for (const targetId of targets) {
				if (!knownIds.has(targetId)) violations.push({ rule: "dangling-edge", detail: `${id} -[${kind}]-> ${targetId} (target outside known node set)` });
				if (targetId === id) violations.push({ rule: "self-loop", detail: `${id} -[${kind}]-> itself` });
				if (kind === "calls" && node && !CALLABLE_KINDS.has(node.kind)) {
					violations.push({ rule: "non-callable-calls-source", detail: `${id} (kind "${node.kind}") has an outgoing 'calls' edge` });
				}
			}
		}
	}
	return violations;
}
