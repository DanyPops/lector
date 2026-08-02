import { describe, expect, test } from "bun:test";
import { type PackageSourceIndexEntry, queryPackageSourceIndex } from "../../src/package-source/package-source-index.ts";

function entry(overrides: Partial<PackageSourceIndexEntry> = {}): PackageSourceIndexEntry {
	return {
		ecosystem: "npm",
		registry: null,
		name: "zod",
		resolvedVersion: "3.22.0",
		requestedVersion: null,
		repositoryUrl: "https://github.com/colinhacks/zod",
		resolvedRef: "v3.22.0",
		commit: "a".repeat(40),
		cachePath: "/cache/zod/3.22.0",
		workspaceId: "workspace-1",
		origin: "fetched",
		verificationMethod: "registry-metadata-and-commit",
		resolvedAt: 1000,
		...overrides,
	};
}

describe("queryPackageSourceIndex", () => {
	test("returns every entry when no filter or bound is exercised", () => {
		const entries = [entry({ name: "zod" }), entry({ name: "react", resolvedVersion: "18.2.0" })];
		const page = queryPackageSourceIndex(entries, {}, 10);
		expect(page.entries).toHaveLength(2);
		expect(page.nextCursor).toBeNull();
	});

	test("filters by ecosystem", () => {
		const entries = [entry({ ecosystem: "npm", name: "zod" }), entry({ ecosystem: "pypi", name: "requests", resolvedVersion: "2.31.0" })];
		const page = queryPackageSourceIndex(entries, { ecosystem: "pypi" }, 10);
		expect(page.entries.map((e) => e.name)).toEqual(["requests"]);
	});

	test("filters by case-insensitive substring across ecosystem/name/resolvedVersion", () => {
		const entries = [entry({ name: "zod", resolvedVersion: "3.22.0" }), entry({ name: "react", resolvedVersion: "18.2.0" })];
		const page = queryPackageSourceIndex(entries, { text: "REACT" }, 10);
		expect(page.entries.map((e) => e.name)).toEqual(["react"]);
	});

	test("sorts deterministically by identity (ecosystem/registry/name/resolvedVersion), not insertion order", () => {
		const entries = [
			entry({ name: "react", resolvedVersion: "18.2.0" }),
			entry({ name: "zod", resolvedVersion: "3.22.0" }),
			entry({ name: "next", resolvedVersion: "14.0.0" }),
		];
		const page = queryPackageSourceIndex(entries, {}, 10);
		expect(page.entries.map((e) => e.name)).toEqual(["next", "react", "zod"]);
	});

	test("paginates via an opaque cursor that stays meaningful across calls", () => {
		const entries = [
			entry({ name: "a", resolvedVersion: "1.0.0" }),
			entry({ name: "b", resolvedVersion: "1.0.0" }),
			entry({ name: "c", resolvedVersion: "1.0.0" }),
		];
		const firstPage = queryPackageSourceIndex(entries, {}, 2);
		expect(firstPage.entries.map((e) => e.name)).toEqual(["a", "b"]);
		expect(firstPage.nextCursor).not.toBeNull();

		const secondPage = queryPackageSourceIndex(entries, {}, 2, firstPage.nextCursor ?? undefined);
		expect(secondPage.entries.map((e) => e.name)).toEqual(["c"]);
		expect(secondPage.nextCursor).toBeNull();
	});

	test("rejects a non-positive-integer maxResults", () => {
		expect(() => queryPackageSourceIndex([entry()], {}, 0)).toThrow(TypeError);
		expect(() => queryPackageSourceIndex([entry()], {}, 1.5)).toThrow(TypeError);
	});
});
