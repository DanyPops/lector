import { describe, expect, it } from "bun:test";
import {
	formatGithubRepoSearchResult,
	formatNpmPackageSearchResult,
	formatSourcegraphCodeSearchResult,
} from "../../extension/src/external-search/rendering.ts";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

describe("external search result rendering", () => {
	it("renders repository identities and descriptions", () => {
		const text = formatGithubRepoSearchResult(
			{
				authenticated: true,
				candidates: [
					{
						host: "github.com",
						owner: "example",
						repo: "widget",
						description: "A useful widget",
						stars: 42,
						language: "TypeScript",
						url: "https://example.test",
					},
				],
			},
			false,
			theme,
		);
		expect(text).toContain("github.com/example/widget");
		expect(text).toContain("A useful widget");
	});

	it("renders npm and source matches rather than counts", () => {
		expect(
			formatNpmPackageSearchResult(
				{ candidates: [{ name: "widget", version: "1.2.3", description: "Package description", repositoryUrl: null, score: 0.9 }] },
				false,
				theme,
			),
		).toContain("widget@1.2.3");
		expect(
			formatSourcegraphCodeSearchResult(
				{
					candidates: [
						{
							repository: "github.com/example/widget",
							path: "src/index.ts",
							lineMatches: [{ line: 4, preview: "export const widget = true" }],
							url: "https://example.test",
						},
					],
				},
				false,
				theme,
			),
		).toContain("4: export const widget = true");
	});

	it("bounds collapsed candidate lists", () => {
		const candidates = Array.from({ length: 10 }, (_, index) => ({
			name: `widget-${index}`,
			version: "1.0.0",
			description: null,
			repositoryUrl: null,
			score: 1,
		}));
		const text = formatNpmPackageSearchResult({ candidates }, false, theme);
		expect(text).toContain("2 more");
		expect(text).not.toContain("widget-9");
	});
});
