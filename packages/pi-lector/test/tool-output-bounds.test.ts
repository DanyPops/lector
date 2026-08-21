import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { boundLectorToolText } from "../extension/src/tool-output-bounds.ts";

describe("boundLectorToolText", () => {
	it("leaves already-bounded tool content byte-for-byte unchanged", () => {
		const output = "a.ts\nb.ts";
		expect(boundLectorToolText(output)).toEqual({ text: output, truncation: undefined });
	});

	it("caps custom tool content to Pi's line limit and appends an honest notice", () => {
		const output = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, index) => `file-${index}.ts`).join("\n");
		const bounded = boundLectorToolText(output);
		expect(bounded.truncation?.truncatedBy).toBe("lines");
		expect(bounded.text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		expect(bounded.text).toContain("[Lector tool output truncated:");
		expect(bounded.text).toContain(`${DEFAULT_MAX_LINES + 100} lines total`);
	});

	it("caps UTF-8 custom tool content to Pi's byte limit without splitting a code point", () => {
		const output = Array.from({ length: 1_000 }, () => "📦".repeat(100)).join("\n");
		const bounded = boundLectorToolText(output);
		expect(bounded.truncation?.truncatedBy).toBe("bytes");
		expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(bounded.text).not.toContain("�");
		expect(bounded.text).toContain("[Lector tool output truncated:");
	});
});
