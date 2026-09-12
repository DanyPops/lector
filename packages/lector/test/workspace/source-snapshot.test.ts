import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "../../src/workspace/local-filesystem-workspace.ts";

describe("bounded source snapshots", () => {
	it("enforces byte and cancellation bounds on both adapters", async () => {
		const root = await mkdtemp(join(tmpdir(), "lector-source-"));
		try {
			await writeFile(join(root, "source.ts"), "éé");
			const memory = new InMemoryWorkspace();
			await memory.writeEntry("source.ts", null, "éé");
			for (const workspace of [memory, new LocalFilesystemWorkspace(root)]) {
				const signal = new AbortController().signal;
				expect(await workspace.readSourceSnapshot("source.ts", 4, signal)).toEqual({ status: "ready", content: "éé" });
				expect(await workspace.readSourceSnapshot("source.ts", 3, signal)).toEqual({ status: "unavailable", reason: "limit" });
				expect(await workspace.readSourceSnapshot("missing.ts", 4, signal)).toEqual({ status: "unavailable", reason: "missing" });
				expect(await workspace.readSourceSnapshot("source.ts", 4, AbortSignal.abort())).toEqual({ status: "unavailable", reason: "aborted" });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
