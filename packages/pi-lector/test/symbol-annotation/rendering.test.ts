import { describe, expect, it } from "bun:test";
import type { SymbolAnnotation } from "@danypops/lector";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";
import { formatAnnotationDetail, formatAnnotationListSummary, formatAnnotationSummary } from "../../extension/src/symbol-annotation/rendering.ts";

const plainTheme: LectorTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function annotation(overrides: Partial<SymbolAnnotation> = {}): SymbolAnnotation {
	return {
		id: "a1",
		subtype: "user-story-dataflow",
		title: "checkout flow",
		body: "explains the mutation chain",
		status: "fresh",
		anchors: [
			{
				symbolNodeId: "src/checkout.ts:12:1" as SymbolAnnotation["anchors"][number]["symbolNodeId"],
				path: "src/checkout.ts",
				fileContentHash: "deadbeef" as SymbolAnnotation["anchors"][number]["fileContentHash"],
			},
		],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("formatAnnotationSummary", () => {
	it("includes status, title, subtype, anchor count, and id", () => {
		const text = formatAnnotationSummary(annotation(), plainTheme);
		expect(text).toContain("[fresh]");
		expect(text).toContain("checkout flow");
		expect(text).toContain("(user-story-dataflow)");
		expect(text).toContain("1 anchor");
		expect(text).toContain("a1");
	});

	it("pluralizes anchor count", () => {
		const base = annotation();
		const two = annotation({ anchors: [...base.anchors, ...base.anchors] });
		expect(formatAnnotationSummary(two, plainTheme)).toContain("2 anchors");
	});
});

describe("formatAnnotationDetail", () => {
	it("includes the full body and every anchor's symbolNodeId", () => {
		const text = formatAnnotationDetail(annotation());
		expect(text).toContain("explains the mutation chain");
		expect(text).toContain("src/checkout.ts:12:1");
		expect(text).toContain("id: a1");
	});
});

describe("formatAnnotationListSummary", () => {
	it('reports "no annotations" for an empty list', () => {
		expect(formatAnnotationListSummary([], plainTheme)).toContain("no annotations");
	});

	it("joins every annotation's summary line", () => {
		const text = formatAnnotationListSummary([annotation({ id: "a1" }), annotation({ id: "a2", title: "second" })], plainTheme);
		expect(text).toContain("a1");
		expect(text).toContain("second");
	});
});
