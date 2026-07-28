/**
 * Shared conformance suite for any SymbolAnnotationPort implementation.
 * Every adapter (InMemorySymbolAnnotations, SqliteSymbolAnnotations, and any
 * future one) must pass this unmodified.
 */
import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import type { CreateSymbolAnnotationInput, SymbolAnnotationAnchor } from "../../src/domain/symbol-annotation.ts";
import type { SymbolAnnotationPort } from "../../src/ports/symbol-annotation-port.ts";

export interface SymbolAnnotationConformanceHarness {
	createPort(): SymbolAnnotationPort | Promise<SymbolAnnotationPort>;
	cleanup?(port: SymbolAnnotationPort): void | Promise<void>;
}

function anchor(path: string, line = 1): SymbolAnnotationAnchor {
	return { symbolNodeId: `${path}:${line}:1`, path, fileContentHash: contentHashOf(`content of ${path}`) };
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
	});
}
