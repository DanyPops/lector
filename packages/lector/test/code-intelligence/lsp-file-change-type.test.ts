import { describe, expect, it } from "bun:test";
import { toLspFileChangeType } from "../../src/code-intelligence/lsp-file-change-type.ts";

describe("toLspFileChangeType", () => {
	it("maps created/modified/deleted to the LSP FileChangeType enum (1/2/3)", () => {
		expect(toLspFileChangeType("created")).toBe(1);
		expect(toLspFileChangeType("modified")).toBe(2);
		expect(toLspFileChangeType("deleted")).toBe(3);
	});
});
