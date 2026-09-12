import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import type { SymbolGraphPort } from "../../src/symbol-graph/port.ts";
import type { WorkspacePort } from "../../src/workspace/port.ts";

export async function recordLocalizationGeneration(workspace: WorkspacePort, graph: SymbolGraphPort): Promise<void> {
	const nodes = await graph.allNodes(200);
	const paths = [...new Set(nodes.map((node) => node.location.path))];
	const entries = await Promise.all(
		paths.map(async (path) => {
			const entry = await workspace.readEntry(path);
			if (!entry.exists) throw new Error(`Missing fixture source: ${path}`);
			return [path, contentHashOf(entry.content)] as const;
		}),
	);
	await graph.setGeneration({
		sourceFingerprint: "fixture",
		completedAt: 1,
		maxFiles: paths.length,
		maxSymbolsPerFile: 200,
		walkedFiles: paths,
		fileContentHashes: Object.fromEntries(entries),
		result: {
			completeness: "complete",
			filesAttempted: paths.length,
			filesProcessed: paths.length,
			filesFailed: 0,
			symbolsProcessed: nodes.length,
			nodesAdded: nodes.length,
			edgesAdded: 0,
			failureCount: 0,
			failures: [],
			failuresTruncated: false,
		},
	});
}
