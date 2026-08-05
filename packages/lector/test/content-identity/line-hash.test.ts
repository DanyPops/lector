import { describe, expect, it } from "bun:test";
import { lineHashOf } from "../../src/content-identity/line-hash.ts";

describe("lineHashOf", () => {
	it("is deterministic for identical content", () => {
		expect(lineHashOf("export const x = 1;")).toBe(lineHashOf("export const x = 1;"));
	});

	it("differs for genuinely different content", () => {
		expect(lineHashOf("export const x = 1;")).not.toBe(lineHashOf("export const x = 2;"));
	});

	it("is sensitive to trailing whitespace -- no fuzzy normalization", () => {
		expect(lineHashOf("export const x = 1;")).not.toBe(lineHashOf("export const x = 1; "));
	});

	it("is 8 lowercase hex characters", () => {
		expect(lineHashOf("anything")).toMatch(/^[0-9a-f]{8}$/);
	});
});
