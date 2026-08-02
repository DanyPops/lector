import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import { SqliteSymbolAnnotations } from "../../src/symbol-annotation/sqlite-symbol-annotations.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import { runSymbolAnnotationPortConformanceSuite } from "../support/symbol-annotation-port-conformance.ts";

runSymbolAnnotationPortConformanceSuite("SqliteSymbolAnnotations", {
	createPort: () => new SqliteSymbolAnnotations(":memory:"),
	cleanup: (port) => (port as SqliteSymbolAnnotations).close(),
});

describe("SqliteSymbolAnnotations durability", () => {
	it("keeps a written annotation and its anchors after the writing instance is closed and a fresh one opens the same file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lector-sqlite-annotations-durability-"));
		const dbPath = join(dir, "annotations.db");
		try {
			const anchors = [{ symbolNodeId: deriveSymbolNodeId({ path: "a.ts", line: 1, character: 1 }), path: "a.ts", fileContentHash: contentHashOf("a") }];

			const first = new SqliteSymbolAnnotations(dbPath);
			const created = await first.create({ subtype: "user-story-dataflow", title: "checkout flow", body: "narrative", anchors });
			first.close();

			const second = new SqliteSymbolAnnotations(dbPath);
			try {
				const fetched = await second.get(created.id);
				expect(fetched).toEqual(created);
			} finally {
				second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
