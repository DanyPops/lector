import { describe, expect, it } from "bun:test";
import type { PackageSourceOperationResult } from "@danypops/lector";
import type { LectorTheme } from "../extension/src/lector-tui-theme.ts";
import { formatPackageSourceCall, formatPackageSourceResult } from "../extension/src/package-source-rendering.ts";

const theme: LectorTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function verified(): PackageSourceOperationResult {
	return {
		workspaceId: "workspace-1",
		outcome: {
			status: "verified",
			coordinate: {
				ecosystem: "npm",
				registry: null,
				name: "@scope/widget",
				requestedVersion: "1.2.3",
				resolvedVersion: "1.2.3",
			},
			repository: {
				url: "https://github.com/acme/widgets.git",
				requestedRef: "1111111111111111111111111111111111111111",
				resolvedRef: "1111111111111111111111111111111111111111",
				commit: "1111111111111111111111111111111111111111",
			},
			workspace: { cachePath: "/cache/widgets", origin: "fetched", readOnly: true },
			verification: { status: "verified", method: "registry-metadata-and-commit", integrity: "git:1111111111111111111111111111111111111111" },
		},
	};
}

describe("package-source rendering", () => {
	it("renders a stable call while arguments stream", () => {
		expect(formatPackageSourceCall({ directory: "/project", name: "@scope/widget", version: "1.2.3" }, theme)).toContain(
			"package_source @scope/widget@1.2.3 /project",
		);
		expect(formatPackageSourceCall({}, theme)).toContain("package_source");
	});

	it("renders verified identity, commit, and reusable workspace", () => {
		const text = formatPackageSourceResult(verified(), false, theme);
		expect(text).toContain("workspace-1");
		expect(text).toContain("@scope/widget@1.2.3");
		expect(text).toContain("1111111111111111111111111111111111111111");
		expect(text).toContain("/cache/widgets");
	});

	it("keeps ambiguous candidates bounded unless expanded", () => {
		const result: PackageSourceOperationResult = {
			workspaceId: null,
			outcome: {
				status: "ambiguous",
				code: "multiple-installed-versions",
				candidates: Array.from({ length: 8 }, (_, index) => ({ version: `1.0.${index}`, source: `lock:${index}` })),
				truncated: false,
			},
		};
		expect(formatPackageSourceResult(result, false, theme).split("\n")).toHaveLength(7);
		expect(formatPackageSourceResult(result, true, theme)).toContain("1.0.7");
	});

	it("renders unavailable, unauthenticated, oversized, and mismatched outcomes distinctly", () => {
		const outcomes: PackageSourceOperationResult[] = [
			{ workspaceId: null, outcome: { status: "unavailable", code: "source-metadata-missing" } },
			{
				workspaceId: null,
				outcome: { status: "unauthenticated", code: "registry-authentication-required", requiredCredentialNames: ["NPM_TOKEN"] },
			},
			{
				workspaceId: null,
				outcome: { status: "oversized", code: "clone-limit-exceeded", resource: "clone-bytes", limit: 10, observed: 11 },
			},
			{
				workspaceId: null,
				outcome: { status: "mismatched", code: "coordinate-mismatch", expected: "widget@1", actual: "widget@2" },
			},
		];
		const rendered = outcomes.map((result) => formatPackageSourceResult(result, false, theme));
		expect(rendered[0]).toContain("unavailable");
		expect(rendered[1]).toContain("NPM_TOKEN");
		expect(rendered[2]).toContain("clone-bytes");
		expect(rendered[3]).toContain("expected widget@1");
	});
});
