import { describe, expect, it } from "bun:test";
import { annotationsContainedFrom, wouldCreateContainmentCycle } from "../../src/symbol-annotation/annotation-containment.ts";
import { InMemorySymbolAnnotations } from "../../src/symbol-annotation/in-memory-symbol-annotations.ts";
import type { CreateSymbolAnnotationInput } from "../../src/symbol-annotation/symbol-annotation.ts";

function input(title: string): CreateSymbolAnnotationInput {
	return { subtype: "comment", title, body: "narrative content", anchors: [{ symbolNodeId: "n:1", path: "src/a.ts", fileContentHash: "sha256:x" as never }] };
}

describe("wouldCreateContainmentCycle", () => {
	it("flags a direct self-loop", async () => {
		const store = new InMemorySymbolAnnotations();
		const a = await store.create(input("a"));

		expect(await wouldCreateContainmentCycle(store, a.id, a.id)).toBe(true);
	});

	it("flags an indirect cycle -- child can already reach the proposed parent", async () => {
		const store = new InMemorySymbolAnnotations();
		const a = await store.create(input("a"));
		const b = await store.create(input("b"));
		const c = await store.create(input("c"));
		await store.addContainmentEdge(a.id, b.id);
		await store.addContainmentEdge(b.id, c.id);

		// Adding c -> a would close the loop a -> b -> c -> a.
		expect(await wouldCreateContainmentCycle(store, c.id, a.id)).toBe(true);
	});

	it("does not flag a genuinely acyclic addition", async () => {
		const store = new InMemorySymbolAnnotations();
		const a = await store.create(input("a"));
		const b = await store.create(input("b"));
		const c = await store.create(input("c"));
		await store.addContainmentEdge(a.id, b.id);

		expect(await wouldCreateContainmentCycle(store, a.id, c.id)).toBe(false);
	});

	it("does not flag reuse of the same child under two different parents -- not a cycle, the point of DRY reuse", async () => {
		const store = new InMemorySymbolAnnotations();
		const flowA = await store.create(input("flow A"));
		const flowB = await store.create(input("flow B"));
		const shared = await store.create(input("shared"));
		await store.addContainmentEdge(flowA.id, shared.id);

		expect(await wouldCreateContainmentCycle(store, flowB.id, shared.id)).toBe(false);
	});
});

describe("annotationsContainedFrom", () => {
	it("returns just the root when it has no children", async () => {
		const store = new InMemorySymbolAnnotations();
		const root = await store.create(input("root"));

		const found = await annotationsContainedFrom(store, root.id, 5);

		expect(found.map((a) => a.id)).toEqual([root.id]);
	});

	it("returns an empty array for a root id that does not exist, not an error", async () => {
		const store = new InMemorySymbolAnnotations();

		expect(await annotationsContainedFrom(store, "never-created", 5)).toEqual([]);
	});

	it("walks multiple levels in BFS order, up to maxDepth", async () => {
		const store = new InMemorySymbolAnnotations();
		const root = await store.create(input("root"));
		const child = await store.create(input("child"));
		const grandchild = await store.create(input("grandchild"));
		await store.addContainmentEdge(root.id, child.id);
		await store.addContainmentEdge(child.id, grandchild.id);

		const found = await annotationsContainedFrom(store, root.id, 5);

		expect(found.map((a) => a.id)).toEqual([root.id, child.id, grandchild.id]);
	});

	it("stops at maxDepth, excluding anything deeper", async () => {
		const store = new InMemorySymbolAnnotations();
		const root = await store.create(input("root"));
		const child = await store.create(input("child"));
		const grandchild = await store.create(input("grandchild"));
		await store.addContainmentEdge(root.id, child.id);
		await store.addContainmentEdge(child.id, grandchild.id);

		const found = await annotationsContainedFrom(store, root.id, 1);

		expect(found.map((a) => a.id)).toEqual([root.id, child.id]);
	});

	it("includes a shared child once, even when reachable through more than one parent in the same traversal", async () => {
		const store = new InMemorySymbolAnnotations();
		const root = await store.create(input("root"));
		const branchA = await store.create(input("branch A"));
		const branchB = await store.create(input("branch B"));
		const shared = await store.create(input("shared"));
		await store.addContainmentEdge(root.id, branchA.id);
		await store.addContainmentEdge(root.id, branchB.id);
		await store.addContainmentEdge(branchA.id, shared.id);
		await store.addContainmentEdge(branchB.id, shared.id);

		const found = await annotationsContainedFrom(store, root.id, 5);

		expect(found.filter((a) => a.id === shared.id)).toHaveLength(1);
	});
});
