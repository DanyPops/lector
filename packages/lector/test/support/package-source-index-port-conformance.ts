/** Shared conformance suite for any PackageSourceIndexPort implementation. */
import { describe, expect, it } from "bun:test";
import type { PackageSourceIndexEntry } from "../../src/domain/package-source-index.ts";
import type { PackageSourceIndexPort } from "../../src/ports/package-source-index-port.ts";

export interface PackageSourceIndexConformanceHarness {
	/** A fresh store; maxEntries lets a test exercise bounded eviction deterministically. */
	createStore(maxEntries?: number): PackageSourceIndexPort | Promise<PackageSourceIndexPort>;
}

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

export function runPackageSourceIndexPortConformanceSuite(name: string, harness: PackageSourceIndexConformanceHarness): void {
	describe(`PackageSourceIndexPort conformance: ${name}`, () => {
		it("records an entry and serves it back via list", async () => {
			const store = await harness.createStore();
			await store.record(entry());
			await expect(store.list()).resolves.toEqual([entry()]);
		});

		it("returns an empty list when nothing has been recorded, not an error", async () => {
			const store = await harness.createStore();
			await expect(store.list()).resolves.toEqual([]);
		});

		it("refreshes rather than duplicates when the same key is recorded again", async () => {
			const store = await harness.createStore();
			await store.record(entry({ resolvedAt: 1000 }));
			await store.record(entry({ resolvedAt: 2000 }));
			const entries = await store.list();
			expect(entries).toHaveLength(1);
			expect(entries[0]?.resolvedAt).toBe(2000);
		});

		it("treats a different resolvedVersion as a distinct entry, not a refresh", async () => {
			const store = await harness.createStore();
			await store.record(entry({ resolvedVersion: "3.22.0" }));
			await store.record(entry({ resolvedVersion: "3.23.0" }));
			const entries = await store.list();
			expect(entries).toHaveLength(2);
		});

		it("removes an entry by its exact key", async () => {
			const store = await harness.createStore();
			await store.record(entry());
			const removed = await store.remove({ ecosystem: "npm", registry: null, name: "zod", resolvedVersion: "3.22.0" });
			expect(removed).toBe(true);
			await expect(store.list()).resolves.toEqual([]);
		});

		it("returns false, not an error, when removing a key that was never recorded", async () => {
			const store = await harness.createStore();
			const removed = await store.remove({ ecosystem: "npm", registry: null, name: "never-recorded", resolvedVersion: "1.0.0" });
			expect(removed).toBe(false);
		});

		it("evicts the OLDEST-recorded entry once maxEntries is exceeded, never a newer one", async () => {
			const store = await harness.createStore(2);
			await store.record(entry({ name: "a", resolvedVersion: "1.0.0" }));
			await store.record(entry({ name: "b", resolvedVersion: "1.0.0" }));
			await store.record(entry({ name: "c", resolvedVersion: "1.0.0" }));

			const entries = await store.list();
			expect(entries.map((e) => e.name).sort()).toEqual(["b", "c"]);
		});
	});
}
