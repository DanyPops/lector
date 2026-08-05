/**
 * Shared conformance suite for any SymbolAnnotationPort implementation.
 * Every adapter (InMemorySymbolAnnotations, SqliteSymbolAnnotations, and any
 * future one) must pass this unmodified.
 */
import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import type { SymbolAnnotationPort } from "../../src/symbol-annotation/port.ts";
import type { CreateSymbolAnnotationInput, SymbolAnnotationAnchor } from "../../src/symbol-annotation/symbol-annotation.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";

export interface SymbolAnnotationConformanceHarness {
	createPort(): SymbolAnnotationPort | Promise<SymbolAnnotationPort>;
	cleanup?(port: SymbolAnnotationPort): void | Promise<void>;
}

function anchor(path: string, line = 1): SymbolAnnotationAnchor {
	return { symbolNodeId: deriveSymbolNodeId({ path, line, character: 1 }), path, fileContentHash: contentHashOf(`content of ${path}`) };
}

function input(overrides: Partial<CreateSymbolAnnotationInput> = {}): CreateSymbolAnnotationInput {
	return {
		subtype: "comment",
		title: "a test annotation",
		body: "narrative content",
		anchors: [anchor("src/a.ts")],
		...overrides,
	};
}

export function runSymbolAnnotationPortConformanceSuite(name: string, harness: SymbolAnnotationConformanceHarness): void {
	async function withPort<T>(fn: (port: SymbolAnnotationPort) => Promise<T>): Promise<T> {
		const port = await harness.createPort();
		try {
			return await fn(port);
		} finally {
			await harness.cleanup?.(port);
		}
	}

	describe(`SymbolAnnotationPort conformance: ${name}`, () => {
		it('creates an annotation with status "fresh" and a generated id', () =>
			withPort(async (port) => {
				const created = await port.create(input());
				expect(created.status).toBe("fresh");
				expect(created.id).toBeTruthy();
				expect(created.anchors).toEqual([anchor("src/a.ts")]);
			}));

		it("round-trips an annotation by id", () =>
			withPort(async (port) => {
				const created = await port.create(input({ title: "roundtrip" }));
				const fetched = await port.get(created.id);
				expect(fetched?.title).toBe("roundtrip");
			}));

		it("returns undefined for an id nothing was ever created under", () =>
			withPort(async (port) => {
				expect(await port.get("never-created")).toBeUndefined();
			}));

		it("lists created annotations, excluding scrubbed ones by default", () =>
			withPort(async (port) => {
				const kept = await port.create(input({ title: "kept" }));
				const scrubbed = await port.create(input({ title: "scrubbed" }));
				await port.scrub(scrubbed.id);

				const listed = await port.list();
				expect(listed.map((a) => a.id)).toContain(kept.id);
				expect(listed.map((a) => a.id)).not.toContain(scrubbed.id);
			}));

		it("list(status) includes scrubbed annotations when explicitly requested", () =>
			withPort(async (port) => {
				const scrubbed = await port.create(input());
				await port.scrub(scrubbed.id);

				const listed = await port.list({ status: "scrubbed" });
				expect(listed.map((a) => a.id)).toEqual([scrubbed.id]);
			}));

		it("filters list() by subtype", () =>
			withPort(async (port) => {
				const dataflow = await port.create(input({ subtype: "user-story-dataflow" }));
				await port.create(input({ subtype: "comment" }));

				const listed = await port.list({ subtype: "user-story-dataflow" });
				expect(listed.map((a) => a.id)).toEqual([dataflow.id]);
			}));

		it("setStatus persists a fresh/stale transition", () =>
			withPort(async (port) => {
				const created = await port.create(input());
				const updated = await port.setStatus(created.id, "stale");
				expect(updated?.status).toBe("stale");
				expect((await port.get(created.id))?.status).toBe("stale");
			}));

		it("refresh replaces body/anchors and resets status to fresh", () =>
			withPort(async (port) => {
				const created = await port.create(input());
				await port.setStatus(created.id, "stale");

				const refreshed = await port.refresh(created.id, input({ body: "new narrative", anchors: [anchor("src/b.ts")] }));
				expect(refreshed?.status).toBe("fresh");
				expect(refreshed?.body).toBe("new narrative");
				expect(refreshed?.anchors).toEqual([anchor("src/b.ts")]);
			}));

		it("scrub excludes an annotation from the default list and get() still finds it", () =>
			withPort(async (port) => {
				const created = await port.create(input());
				expect(await port.scrub(created.id)).toBe(true);

				expect(await port.get(created.id)).toMatchObject({ status: "scrubbed" });
				expect(await port.list()).toEqual([]);
			}));

		it("scrub is not idempotent -- scrubbing an already-scrubbed annotation returns false", () =>
			withPort(async (port) => {
				const created = await port.create(input());
				await port.scrub(created.id);
				expect(await port.scrub(created.id)).toBe(false);
			}));

		it('restore returns a scrubbed annotation to "stale", never "fresh"', () =>
			withPort(async (port) => {
				const created = await port.create(input());
				await port.scrub(created.id);

				expect(await port.restore(created.id)).toBe(true);
				expect((await port.get(created.id))?.status).toBe("stale");
			}));

		it("restore on a non-scrubbed annotation returns false", () =>
			withPort(async (port) => {
				const created = await port.create(input());
				expect(await port.restore(created.id)).toBe(false);
			}));

		it("filters list() by query, matching title or body, case-insensitively", () =>
			withPort(async (port) => {
				const byTitle = await port.create(input({ title: "PaymentProcessor dataflow", body: "unrelated body" }));
				const byBody = await port.create(input({ title: "unrelated title", body: "touches PaymentProcessor internally" }));
				await port.create(input({ title: "nothing to do with it", body: "still nothing" }));

				const listed = await port.list({ query: "paymentprocessor" });
				expect(listed.map((a) => a.id).sort()).toEqual([byBody.id, byTitle.id].sort());
			}));

		it("query matches a literal '%' in the annotation body instead of treating it as a wildcard", () =>
			withPort(async (port) => {
				const withPercent = await port.create(input({ title: "perf note", body: "reduces latency by 40% in the common case" }));
				await port.create(input({ title: "unrelated", body: "reduces latency by some amount" }));

				const listed = await port.list({ query: "40%" });
				expect(listed.map((a) => a.id)).toEqual([withPercent.id]);
			}));

		it("query combines with subtype -- both must match", () =>
			withPort(async (port) => {
				const match = await port.create(input({ subtype: "user-story-dataflow", title: "checkout flow", body: "n/a" }));
				await port.create(input({ subtype: "comment", title: "checkout flow", body: "n/a" }));

				const listed = await port.list({ subtype: "user-story-dataflow", query: "checkout" });
				expect(listed.map((a) => a.id)).toEqual([match.id]);
			}));

		it("query matching nothing returns an empty list, not an error", () =>
			withPort(async (port) => {
				await port.create(input());
				expect(await port.list({ query: "definitely-not-present-anywhere" })).toEqual([]);
			}));

		it("list() is bounded by maxResults", () =>
			withPort(async (port) => {
				await port.create(input({ title: "one" }));
				await port.create(input({ title: "two" }));
				await port.create(input({ title: "three" }));

				expect((await port.list({ maxResults: 2 })).length).toBe(2);
			}));

		it("addContainmentEdge reports whether the edge was newly created, and children()/parents() see it from both ends", () =>
			withPort(async (port) => {
				const parent = await port.create(input({ title: "parent" }));
				const child = await port.create(input({ title: "child" }));

				expect(await port.addContainmentEdge(parent.id, child.id)).toBe(true);
				expect(await port.addContainmentEdge(parent.id, child.id)).toBe(false);
				expect(await port.children(parent.id)).toEqual([child.id]);
				expect(await port.parents(child.id)).toEqual([parent.id]);
			}));

		it("children() reflects insertion order across multiple children", () =>
			withPort(async (port) => {
				const parent = await port.create(input({ title: "parent" }));
				const first = await port.create(input({ title: "first" }));
				const second = await port.create(input({ title: "second" }));

				await port.addContainmentEdge(parent.id, first.id);
				await port.addContainmentEdge(parent.id, second.id);

				expect(await port.children(parent.id)).toEqual([first.id, second.id]);
			}));

		it("one child can be contained by more than one parent -- the reuse this feature exists for", () =>
			withPort(async (port) => {
				const flowA = await port.create(input({ title: "flow A" }));
				const flowB = await port.create(input({ title: "flow B" }));
				const sharedSymbolNote = await port.create(input({ title: "shared per-symbol note" }));

				await port.addContainmentEdge(flowA.id, sharedSymbolNote.id);
				await port.addContainmentEdge(flowB.id, sharedSymbolNote.id);

				expect(await port.parents(sharedSymbolNote.id)).toEqual(expect.arrayContaining([flowA.id, flowB.id]));
				expect(await port.children(flowA.id)).toEqual([sharedSymbolNote.id]);
				expect(await port.children(flowB.id)).toEqual([sharedSymbolNote.id]);
			}));

		it("removeContainmentEdge reports whether an edge was actually removed, and is idempotent on an already-absent edge", () =>
			withPort(async (port) => {
				const parent = await port.create(input({ title: "parent" }));
				const child = await port.create(input({ title: "child" }));
				await port.addContainmentEdge(parent.id, child.id);

				expect(await port.removeContainmentEdge(parent.id, child.id)).toBe(true);
				expect(await port.children(parent.id)).toEqual([]);
				expect(await port.removeContainmentEdge(parent.id, child.id)).toBe(false);
			}));

		it("removeContainmentEdge on ids that never had any relationship is a harmless no-op, not an error", () =>
			withPort(async (port) => {
				const a = await port.create(input({ title: "a" }));
				const b = await port.create(input({ title: "b" }));

				expect(await port.removeContainmentEdge(a.id, b.id)).toBe(false);
			}));

		it("children()/parents() return an empty list for an id with no relationships, not an error", () =>
			withPort(async (port) => {
				const lone = await port.create(input({ title: "lone" }));

				expect(await port.children(lone.id)).toEqual([]);
				expect(await port.parents(lone.id)).toEqual([]);
			}));
	});
}
