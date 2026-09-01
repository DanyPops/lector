import { describe, expect, it } from "bun:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	LECTOR_PRESENTATION_SCHEMA,
	parseLectorPresentation,
	projectLectorPresentation,
	withLectorPresentation,
} from "../extension/src/presentation/presentation-contract.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function context(overrides: Record<string, unknown> = {}) {
	return {
		args: { query: "needle" },
		toolCallId: "call-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/workspace",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	} as never;
}

describe("Lector presentation contract", () => {
	it("projects serializable details into a versioned independently bounded envelope", () => {
		const envelope = projectLectorPresentation("find_symbols", { symbols: [{ name: "Widget" }] }, 1024);
		expect(envelope).toEqual({
			schema: LECTOR_PRESENTATION_SCHEMA,
			tool: "find_symbols",
			action: null,
			family: "symbols",
			payload: { symbols: [{ name: "Widget" }] },
		});
		expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(1024);
		expect(parseLectorPresentation(envelope, "find_symbols")).toEqual({ symbols: [{ name: "Widget" }] });
	});

	it("rejects cyclic, non-finite, mismatched, and oversized presentation details", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => projectLectorPresentation("find_symbols", cyclic, 1024)).toThrow(/serializable/);
		expect(() => projectLectorPresentation("find_symbols", { score: Number.NaN }, 1024)).toThrow(/serializable/);
		expect(() => projectLectorPresentation("find_symbols", { body: "x".repeat(100) }, 32)).toThrow(/presentation details exceed/);
		const valid = projectLectorPresentation("find_symbols", { symbols: [] }, 1024);
		expect(parseLectorPresentation(valid, "search_code")).toBeUndefined();
		expect(parseLectorPresentation({ ...valid, schema: "future/v2" }, "find_symbols")).toBeUndefined();
	});

	it("wraps production execution, updates, rendering, and malformed replay fallback", async () => {
		type Details = { readonly count: number };
		const base: ToolDefinition<ReturnType<typeof Type.Object>, Details> = {
			name: "find_symbols",
			label: "Find Symbols",
			description: "fixture",
			parameters: Type.Object({ query: Type.String() }),
			async execute(_id, _params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "working" }], details: { count: 1 } });
				return { content: [{ type: "text", text: "MODEL: 2 symbols" }], details: { count: 2 } };
			},
			renderResult(result) {
				return new Text(`PRESENTATION: ${result.details?.count ?? 0}`, 0, 0);
			},
		};
		const wrapped = withLectorPresentation(base, { maxBytes: 1024 });
		const updates: unknown[] = [];
		const result = await wrapped.execute("call-1", { query: "Widget" }, undefined, (update) => updates.push(update), context());

		expect(result.content).toEqual([{ type: "text", text: "MODEL: 2 symbols" }]);
		expect(parseLectorPresentation(result.details, "find_symbols")).toEqual({ count: 2 });
		expect(parseLectorPresentation((updates[0] as { details: unknown }).details, "find_symbols")).toEqual({ count: 1 });
		expect(
			wrapped
				.renderResult?.(result, { expanded: false, isPartial: false }, theme, context())
				.render(80)
				.map((line) => line.trimEnd()),
		).toEqual(["PRESENTATION: 2"]);

		const malformed = { ...result, details: { schema: "future/v2" } };
		expect(
			wrapped
				.renderResult?.(malformed as never, { expanded: false, isPartial: false }, theme, context())
				.render(80)
				.map((line) => line.trimEnd()),
		).toEqual(["MODEL: 2 symbols"]);
	});
});
