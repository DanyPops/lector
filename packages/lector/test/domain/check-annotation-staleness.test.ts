/** Uses InMemorySymbolGraph and InMemoryWorkspace directly -- a real seam, not mocks of the ports. */
import { describe, expect, it } from "bun:test";
import { InMemorySymbolGraph } from "../../src/adapters/in-memory-symbol-graph.ts";
import { InMemoryWorkspace } from "../../src/adapters/in-memory-workspace.ts";
import { checkAnnotationStaleness } from "../../src/domain/check-annotation-staleness.ts";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import type { SymbolAnnotation } from "../../src/domain/symbol-annotation.ts";

function annotationOver(anchors: SymbolAnnotation["anchors"]): SymbolAnnotation {
	return { id: "a1", subtype: "comment", title: "t", body: "b", status: "fresh", anchors, createdAt: 0, updatedAt: 0 };
}

describe("checkAnnotationStaleness", () => {
	it("is not stale when the anchored node still exists and the file's content is unchanged", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("a.ts", null, "export function add() {}");
		await graph.addNode({ id: "a.ts:1:1", name: "add", kind: "function", location: { path: "a.ts", line: 1, character: 1 } });

		const annotation = annotationOver([{ symbolNodeId: "a.ts:1:1", path: "a.ts", fileContentHash: contentHashOf("export function add() {}") }]);
		expect(await checkAnnotationStaleness(graph, workspace, annotation)).toBe(false);
	});

	it("is stale when the anchored node no longer exists in the graph (renamed or deleted)", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("a.ts", null, "export function add() {}");
		// Note: no addNode call -- the graph genuinely has no record of this symbol anymore.

		const annotation = annotationOver([{ symbolNodeId: "a.ts:1:1", path: "a.ts", fileContentHash: contentHashOf("export function add() {}") }]);
		expect(await checkAnnotationStaleness(graph, workspace, annotation)).toBe(true);
	});

	it("is stale when the file's content changed since the anchor was recorded, even though the node still resolves", async () => {
		const graph = new InMemorySymbolGraph();
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("a.ts", null, "export function add(a, b) { return a + b; }");
		await graph.addNode({ id: "a.ts:1:1", name: "add", kind: "function", location: { path: "a.ts", line: 1, character: 1 } });

		// Anchor recorded against the OLD content -- the file has since changed.
		const annotation = annotationOver([{ symbolNodeId: "a.ts:1:1", path: "a.ts", fileContentHash: contentHashOf("export function add() {}") }]);
		expect(await checkAnnotationStaleness(graph, workspace, annotation)).toBe(true);
	});

	it("reads a multiply-anchored file only once (two anchors in the same file share one workspace read)", async () => {
		const graph = new InMemorySymbolGraph();
		let reads = 0;
		const workspace = new InMemoryWorkspace();
		await workspace.writeEntry("a.ts", null, "export function add() {}\nexport function sub() {}");
		const originalReadEntry = workspace.readEntry.bind(workspace);
		workspace.readEntry = async (path: string) => {
			reads++;
			return originalReadEntry(path);
		};
		await graph.addNode({ id: "a.ts:1:1", name: "add", kind: "function", location: { path: "a.ts", line: 1, character: 1 } });
		await graph.addNode({ id: "a.ts:2:1", name: "sub", kind: "function", location: { path: "a.ts", line: 2, character: 1 } });

		const hash = contentHashOf("export function add() {}\nexport function sub() {}");
		const annotation = annotationOver([
			{ symbolNodeId: "a.ts:1:1", path: "a.ts", fileContentHash: hash },
			{ symbolNodeId: "a.ts:2:1", path: "a.ts", fileContentHash: hash },
		]);
		expect(await checkAnnotationStaleness(graph, workspace, annotation)).toBe(false);
		expect(reads).toBe(1);
	});
});
