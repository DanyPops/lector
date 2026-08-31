import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FffIndexedTextEngineFactory } from "../../src/text-search/fff-indexed-text-engine.ts";

const roots: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-fff-index-"));
	roots.push(root);
	writeFileSync(join(root, "source.ts"), "éneedle42 and needle43\n");
	for (const directory of ["node_modules", "dist", "build", "out", "coverage"]) {
		mkdirSync(join(root, directory));
		writeFileSync(join(root, directory, "ignored.ts"), "needle99\n");
	}
	return root;
}

function factory(cacheRoot: string, overrides: Partial<ConstructorParameters<typeof FffIndexedTextEngineFactory>[0]> = {}) {
	return new FffIndexedTextEngineFactory({
		cacheRoot,
		buildTimeoutMs: 30_000,
		searchTimeoutMs: 5_000,
		maxFiles: 100,
		maxSourceBytes: 10_000_000,
		maxSingleFileBytes: 1_000_000,
		maxPersistedIdentities: 8,
		maxPersistedIdentityBytes: 64_000,
		...overrides,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FffIndexedTextEngine", () => {
	it("rejects non-finite resource bounds", () => {
		const cacheRoot = fixture();
		expect(() => factory(cacheRoot, { maxFiles: Number.POSITIVE_INFINITY })).toThrow("positive safe integers");
	});

	it("builds a bounded resident index with regex, ignore, UTF-8, and provenance metadata", async () => {
		const root = fixture();
		const cacheRoot = fixture();
		const engine = factory(cacheRoot).open(root);
		expect((await engine.status()).state).toBe("missing");
		await engine.build(new AbortController().signal);
		const status = await engine.status();
		expect(status.state).toBe("fresh");
		expect(status.indexedFiles).toBe(5);
		expect(status.persistedIdentity).toMatch(/^[a-f0-9]{64}$/);
		const result = await engine.search("needle\\d+", { maxMatches: 10, maxBytes: 10_000 });
		expect(result.matches.map((match) => match.path)).toEqual(["source.ts"]);
		expect(result.matches[0]).toMatchObject({ lineNumber: 1, matchStart: 2, matchEnd: 10 });
		expect(result.matches.some((match) => match.path.includes("node_modules"))).toBe(false);
	});

	it("rejects an over-limit rebuild and keeps the prior index usable", async () => {
		const root = fixture();
		const cacheRoot = fixture();
		const engine = factory(cacheRoot, { maxFiles: 5 }).open(root);
		await engine.build(new AbortController().signal);
		writeFileSync(join(root, "second.ts"), "secondNeedle\n");
		await expect(engine.build(new AbortController().signal)).rejects.toThrow("exceeds 5 files");
		const result = await engine.search("needle42", { maxMatches: 10, maxBytes: 10_000 });
		expect(result.matches.some((match) => match.path === "source.ts")).toBe(true);
	});

	it("honors cancellation before allocating a finder", async () => {
		const root = fixture();
		const cacheRoot = fixture();
		const engine = factory(cacheRoot).open(root);
		const controller = new AbortController();
		controller.abort();
		await expect(engine.build(controller.signal)).rejects.toThrow("aborted");
		expect((await engine.status()).state).toBe("missing");
	});

	it("retains local persisted identity ahead of remote identity", async () => {
		const localRoot = fixture();
		const remoteRoot = fixture();
		const cacheRoot = fixture();
		const indexFactory = factory(cacheRoot, { maxPersistedIdentities: 1 });
		const local = indexFactory.open(localRoot);
		local.setOrigin?.("local");
		await local.build(new AbortController().signal);
		const remote = indexFactory.open(remoteRoot);
		remote.setOrigin?.("remote");
		await remote.build(new AbortController().signal);
		expect((await indexFactory.open(localRoot).status()).persistedIdentity).toBeDefined();
		expect((await indexFactory.open(remoteRoot).status()).persistedIdentity).toBeUndefined();
	});
});
