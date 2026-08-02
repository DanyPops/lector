import { describe, expect, it } from "bun:test";
import type { CachedRepositoryEntry } from "@danypops/lector";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { LectorTheme } from "../../extension/src/lector-tui-theme.ts";
import { buildRepoCacheTableRows, formatRepoCacheListResult, REPO_CACHE_VISIBLE_ROWS, repoCacheMoreLine } from "../../extension/src/repo-cache/rendering.ts";

// repoCacheMoreLine's keyHint() reads pi's global theme singleton, independent of the fake theme below.
initTheme();

const theme: LectorTheme = { fg: (_color, text) => text, bold: (text) => text };

function entry(overrides: Partial<CachedRepositoryEntry> = {}): CachedRepositoryEntry {
	return {
		host: "github.com",
		owner: "acme",
		repo: "widgets",
		requestedRef: "HEAD",
		resolvedRef: "main",
		commit: "1111111111111111111111111111111111111111",
		path: "/cache/acme/widgets",
		cacheSizeBytes: 2_500_000,
		fetchedAt: Date.parse("2026-01-01T00:00:00.000Z"),
		registeredWorkspaceId: null,
		...overrides,
	};
}

describe("formatRepoCacheListResult (empty-state fallback)", () => {
	it("reports no cached repositories for an empty or undefined page", () => {
		expect(formatRepoCacheListResult(undefined, theme)).toContain("no cached repositories");
		expect(formatRepoCacheListResult({ entries: [], nextCursor: null }, theme)).toContain("no cached repositories");
	});
});

describe("buildRepoCacheTableRows", () => {
	it("builds one row per entry with real host/owner/repo, not just a bare count", () => {
		const rows = buildRepoCacheTableRows([entry()]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.repo).toBe("github.com/acme/widgets");
	});

	it("shows the ref as-is when requested and resolved match", () => {
		const rows = buildRepoCacheTableRows([entry({ requestedRef: "main", resolvedRef: "main" })]);
		expect(rows[0]?.ref).toBe("main");
	});

	it("shows a fallback arrow when the requested ref differs from the resolved one", () => {
		const rows = buildRepoCacheTableRows([entry({ requestedRef: "HEAD", resolvedRef: "main" })]);
		expect(rows[0]?.ref).toBe("HEAD -> main");
	});

	it("reports the registered workspace id when registered, or 'no' when not", () => {
		const registered = buildRepoCacheTableRows([entry({ registeredWorkspaceId: "workspace-7" })]);
		expect(registered[0]?.registered).toBe("workspace-7");
		const unregistered = buildRepoCacheTableRows([entry({ registeredWorkspaceId: null })]);
		expect(unregistered[0]?.registered).toBe("no");
	});

	it("formats cache size in human-readable units", () => {
		const rows = buildRepoCacheTableRows([entry({ cacheSizeBytes: 2_500_000 })]);
		expect(rows[0]?.size).toBe("2.4 MB");
	});

	it("formats a sub-KB size as whole bytes with no decimal", () => {
		const rows = buildRepoCacheTableRows([entry({ cacheSizeBytes: 512 })]);
		expect(rows[0]?.size).toBe("512 B");
	});

	it("formats fetchedAt as an ISO timestamp", () => {
		const rows = buildRepoCacheTableRows([entry({ fetchedAt: Date.parse("2026-01-01T00:00:00.000Z") })]);
		expect(rows[0]?.fetched).toBe("2026-01-01T00:00:00.000Z");
	});

	it("returns an empty array for an empty entry list", () => {
		expect(buildRepoCacheTableRows([])).toEqual([]);
	});
});

describe("repoCacheMoreLine", () => {
	it("reports the real hidden count", () => {
		expect(repoCacheMoreLine(theme)(5)).toContain("5");
		expect(repoCacheMoreLine(theme)(1)).toContain("1");
	});
});

describe("REPO_CACHE_VISIBLE_ROWS", () => {
	it("is a positive bound, guarding against an unbounded cache list display", () => {
		expect(REPO_CACHE_VISIBLE_ROWS).toBeGreaterThan(0);
	});
});
