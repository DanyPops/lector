import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";
import type { DocumentSymbolEntry } from "./document-symbol.ts";
import { deriveSymbolNodeId } from "./symbol-node-id.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);

export interface PopulateSymbolGraphResult {
	readonly filesProcessed: number;
	readonly symbolsProcessed: number;
	/** addNode calls made, not necessarily new nodes -- a symbol reached from multiple edges is upserted once per encounter within a run, deduped in-memory. */
	readonly nodesAdded: number;
	readonly edgesAdded: number;
}

function toLocation(entry: DocumentSymbolEntry): WorkspaceLocation {
	return { path: entry.selectionRange.path, line: entry.selectionRange.start.line, character: entry.selectionRange.start.character };
}

interface FlattenedEntry {
	readonly entry: DocumentSymbolEntry;
	readonly parentLocation: WorkspaceLocation | undefined;
}

/** Depth-first flatten of a documentSymbols hierarchy, keeping each entry's parent location for "contains" edges. */
function flattenDocumentSymbols(entries: readonly DocumentSymbolEntry[], parentLocation?: WorkspaceLocation): FlattenedEntry[] {
	const flattened: FlattenedEntry[] = [];
	for (const entry of entries) {
		flattened.push({ entry, parentLocation });
		if (entry.children) flattened.push(...flattenDocumentSymbols(entry.children, toLocation(entry)));
	}
	return flattened;
}

/**
 * Walks documentSymbols for each file, then outgoingCalls for every callable
 * declaration found, to fill a SymbolGraphPort with real "contains" (free,
 * from the hierarchy already returned) and "calls" (one LSP round trip per
 * callable symbol) edges. maxSymbolsPerFile bounds a single large file's
 * declarations rather than processing an unbounded number from it.
 */
export async function populateSymbolGraph(
	index: CodeIntelligencePort,
	graph: SymbolGraphPort,
	files: readonly string[],
	maxSymbolsPerFile: number,
): Promise<PopulateSymbolGraphResult> {
	let filesProcessed = 0;
	let symbolsProcessed = 0;
	let nodesAdded = 0;
	let edgesAdded = 0;
	const addedNodeIds = new Set<string>();

	async function ensureNode(node: SymbolNode): Promise<void> {
		if (addedNodeIds.has(node.id)) return;
		addedNodeIds.add(node.id);
		await graph.addNode(node);
		nodesAdded++;
	}

	for (const file of files) {
		const topLevel = await index.documentSymbols(file);
		const flattened = flattenDocumentSymbols(topLevel).slice(0, maxSymbolsPerFile);
		filesProcessed++;

		for (const { entry, parentLocation } of flattened) {
			symbolsProcessed++;
			const location = toLocation(entry);
			const node: SymbolNode = { id: deriveSymbolNodeId(location), name: entry.name, kind: entry.kind, location };
			await ensureNode(node);

			if (parentLocation) {
				await graph.addEdge(deriveSymbolNodeId(parentLocation), node.id, "contains");
				edgesAdded++;
			}

			if (CALLABLE_KINDS.has(entry.kind)) {
				const callees = await index.outgoingCalls(location);
				for (const call of callees) {
					const calleeNode: SymbolNode = { id: deriveSymbolNodeId(call.to.location), name: call.to.name, kind: call.to.kind, location: call.to.location };
					await ensureNode(calleeNode);
					await graph.addEdge(node.id, calleeNode.id, "calls");
					edgesAdded++;
				}
			}
		}
	}

	return { filesProcessed, symbolsProcessed, nodesAdded, edgesAdded };
}
