import { describe, expect, it } from "bun:test";
import {
	LECTOR_TOOL_PRESENTATION_SPECS,
	type PresentationFamily,
	presentationPathCount,
	presentationTitle,
} from "../extension/src/presentation/tool-presentation.ts";

const EXPECTED_FAMILIES = new Set<PresentationFamily>([
	"source",
	"markdown",
	"symbols",
	"locations",
	"diagnostics",
	"diff",
	"mutation",
	"status",
	"table",
	"tree",
	"candidates",
	"semantic-text",
]);

describe("Lector tool presentation matrix", () => {
	it("covers every Lector-owned tool and action from the audited public surface", () => {
		expect(Object.keys(LECTOR_TOOL_PRESENTATION_SPECS)).toHaveLength(34);
		expect(presentationPathCount()).toBe(69);
	});

	it("gives every path a human title and fitting presentation family", () => {
		for (const [toolName, spec] of Object.entries(LECTOR_TOOL_PRESENTATION_SPECS)) {
			const paths: ReadonlyArray<readonly [string, { readonly title: string; readonly family: PresentationFamily }]> = spec.actions
				? Object.entries(spec.actions)
				: [["default", { title: spec.title, family: spec.family }]];
			for (const [action, path] of paths) {
				expect(path.title, `${toolName}:${action}`).toMatch(/^[A-Z]/);
				expect(path.title, `${toolName}:${action}`).not.toContain("_");
				expect(EXPECTED_FAMILIES.has(path.family), `${toolName}:${action}`).toBe(true);
				expect(presentationTitle(toolName, action === "default" ? undefined : action)).toBe(path.title);
			}
		}
	});

	it("uses action intent rather than generic multiplexer labels", () => {
		expect(presentationTitle("git", "grep-history")).toBe("Search Git History");
		expect(presentationTitle("workspace_cache", "populate")).toBe("Populate Workspace Cache");
		expect(presentationTitle("package_source", "resolve")).toBe("Resolve Package Source");
		expect(presentationTitle("symbol_annotations", "tree")).toBe("Annotation Tree");
	});
});
