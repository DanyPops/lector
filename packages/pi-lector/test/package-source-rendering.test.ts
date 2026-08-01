import { describe, expect, it } from "bun:test";
import type { PackageSourceListEntry, PackageSourceOperationResult } from "@danypops/lector";
import type { LectorTheme } from "../extension/src/lector-tui-theme.ts";
import {
	buildPackageSourceListTableRows,
	formatPackageSourceCall,
	formatPackageSourceCleanResult,
	formatPackageSourceListResult,
	formatPackageSourceRemoveResult,
	formatPackageSourceResult,
} from "../extension/src/package-source-rendering.ts";

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

	function listEntry(overrides: Partial<PackageSourceListEntry> = {}): PackageSourceListEntry {
		return {
			ecosystem: "npm",
			registry: null,
			name: "@scope/widget",
			resolvedVersion: "1.2.3",
			requestedVersion: "1.2.3",
			repositoryUrl: "https://github.com/acme/widgets.git",
			resolvedRef: "1111111111111111111111111111111111111111",
			commit: "1111111111111111111111111111111111111111",
			cachePath: "/cache/widgets",
			workspaceId: "workspace-1",
			origin: "fetched",
			verificationMethod: "registry-metadata-and-commit",
			resolvedAt: 1_700_000_000_000,
			cacheSizeBytes: 2048,
			...overrides,
		};
	}

	it("renders list/remove/clean call shapes distinctly from resolve", () => {
		expect(formatPackageSourceCall({ action: "list", text: "widget" }, theme)).toContain("list");
		expect(formatPackageSourceCall({ action: "remove", ecosystem: "npm", name: "@scope/widget", resolvedVersion: "1.2.3" }, theme)).toContain(
			"@scope/widget@1.2.3",
		);
		expect(formatPackageSourceCall({ action: "clean", ecosystem: "npm" }, theme)).toContain("clean");
	});

	it("formatPackageSourceListResult is an empty-state fallback only -- a non-empty page renders as a Table", () => {
		expect(formatPackageSourceListResult({ entries: [], nextCursor: null }, theme)).toContain("no");
		expect(formatPackageSourceListResult({ entries: [listEntry()], nextCursor: null }, theme)).toContain("1");
	});

	it("builds one table row per package-source entry with human-readable size and identity", () => {
		const rows = buildPackageSourceListTableRows([listEntry(), listEntry({ name: "react", cacheSizeBytes: null })]);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.package).toContain("@scope/widget@1.2.3");
		expect(rows[0]?.size).not.toBe("");
		expect(rows[1]?.size).toBe("unknown");
	});

	it("renders remove/clean results", () => {
		expect(formatPackageSourceRemoveResult({ removed: true }, theme)).toContain("removed");
		expect(formatPackageSourceRemoveResult({ removed: false }, theme)).toContain("not");
		expect(formatPackageSourceCleanResult({ removed: 3, skipped: 1 }, theme)).toContain("3");
		expect(formatPackageSourceCleanResult({ removed: 3, skipped: 1 }, theme)).toContain("1");
	});
});
