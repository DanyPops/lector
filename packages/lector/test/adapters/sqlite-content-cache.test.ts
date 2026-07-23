/**
 * Checklist (task 8c1dedd6's prerequisite -- durable derived-state, before
 * purge ordering is even reachable): SqliteContentCache is Lector's first
 * genuinely durable store. The conformance suite proves correctness; the
 * "survives reopen" test below is the actual durability proof -- a value
 * written by one process/instance is still there after that instance is
 * gone and a fresh one opens the same file.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteContentCache } from "../../src/adapters/sqlite-content-cache.ts";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import { runContentCachePortConformanceSuite } from "../support/content-cache-port-conformance.ts";

runContentCachePortConformanceSuite("SqliteContentCache", {
	createCache: () => new SqliteContentCache(":memory:"),
	cleanup: (cache) => (cache as SqliteContentCache).close(),
});

describe("SqliteContentCache durability", () => {
	it("keeps a written entry after the writing instance is closed and a fresh one opens the same file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-cache-durability-"));
		const dbPath = join(dir, "content-cache.db");
		try {
			const hash = contentHashOf("export function add() {}");
			const symbols = [{ name: "add", kind: "function", line: 1, character: 1 }];

			const first = new SqliteContentCache(dbPath);
			await first.putRawContent(hash, "export function add() {}");
			await first.putSymbols(hash, symbols);
			first.close();

			// A genuinely new instance -- no shared in-process state with `first` at all,
			// only the database file on disk. This is the actual claim "durable" makes.
			const second = new SqliteContentCache(dbPath);
			try {
				expect(await second.get(hash)).toEqual({ rawContent: "export function add() {}", symbols });
			} finally {
				second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
