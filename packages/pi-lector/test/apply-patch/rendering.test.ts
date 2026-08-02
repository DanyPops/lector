import { describe, expect, it } from "bun:test";
import { formatApplyPatchCall, formatApplyPatchResult } from "../../extension/src/apply-patch/rendering.ts";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

const REAL_PATCH = "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 patched\n line 3\n";

describe("formatApplyPatchCall", () => {
	it("renders just the header when patchText is missing or empty (still streaming in)", () => {
		expect(formatApplyPatchCall({ path: "src/a.ts" }, theme)).toBe("apply_patch src/a.ts");
		expect(formatApplyPatchCall({ path: "src/a.ts", patchText: "" }, theme)).toBe("apply_patch src/a.ts");
	});

	it("appends a real colored diff preview once patchText is present", () => {
		const text = formatApplyPatchCall({ path: "src/a.ts", patchText: REAL_PATCH }, theme);
		expect(text).toContain("apply_patch src/a.ts");
		expect(text).toContain("-line 2");
		expect(text).toContain("+line 2 patched");
	});

	it("caps the preview and reports a plain hidden-line count, with no expand hint (renderCall has no expand affordance)", () => {
		const bigPatch = `@@ -1,20 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => ` line ${i}`).join("\n")}\n`;
		const text = formatApplyPatchCall({ path: "src/a.ts", patchText: bigPatch }, theme);
		expect(text).toContain("more line");
		expect(text).not.toContain("expand");
	});
});

describe("formatApplyPatchResult", () => {
	it("renders the hash transition -- the applied diff text itself isn't in EditOutcome", () => {
		const text = formatApplyPatchResult({ path: "/a.ts", previousHash: "abc" as never, newHash: "def" as never }, theme);
		expect(text).toContain("abc");
		expect(text).toContain("def");
	});

	it("renders a placeholder when there's no result", () => {
		expect(formatApplyPatchResult(undefined, theme)).toContain("No result");
	});
});
