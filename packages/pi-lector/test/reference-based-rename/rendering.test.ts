import { describe, expect, it } from "bun:test";
import type { OperationOutputs } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";
import { formatReferenceBasedRenameModelContent, formatReferenceBasedRenameResult } from "../../extension/src/reference-based-rename/rendering.ts";

initTheme();
const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

const outcome: OperationOutputs["workspace.referenceBasedRename"] = {
	movedTo: "/repo/src/arithmetic.ts",
	filesUpdated: ["/repo/src/consumer.ts"],
	caveats: ["static imports only"],
	transactionId: "tx-rename-1",
};

describe("reference-based rename output", () => {
	it("includes the reusable transaction identity in model content", () => {
		const text = formatReferenceBasedRenameModelContent(outcome);
		expect(text).toContain("transaction tx-rename-1");
		expect(text).toContain("moved to /repo/src/arithmetic.ts");
		expect(text).toContain("/repo/src/consumer.ts");
		expect(text).toContain("caveat: static imports only");
	});

	it("includes the transaction identity in human presentation", () => {
		const text = formatReferenceBasedRenameResult(outcome, theme);
		expect(text).toContain("tx-rename-1");
		expect(text).toContain("arithmetic.ts");
		expect(text).toContain("1 import(s) updated");
	});
});
