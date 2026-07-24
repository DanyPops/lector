import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSeedFile, NoSeedFileFound } from "../../../src/adapters/lsp/discover-seed-file.ts";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const TS_COMMON_CANDIDATES = ["src/index.ts", "index.ts", "src/main.ts", "main.ts", "src/index.tsx", "index.tsx", "src/index.js", "index.js"];

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function freshRoot(): string {
	root = mkdtempSync(join(tmpdir(), "lector-discover-seed-"));
	return root;
}

describe("discoverSeedFile", () => {
	it("prefers a common entry-point candidate over an arbitrary scanned file", () => {
		const dir = freshRoot();
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "index.ts"), "export {};");
		writeFileSync(join(dir, "unrelated.ts"), "export {};"); // would also be found by scanning

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES)).toBe(join("src", "index.ts"));
	});

	it("falls back to a bounded directory scan when no common candidate exists", () => {
		const dir = freshRoot();
		mkdirSync(join(dir, "lib"), { recursive: true });
		writeFileSync(join(dir, "lib", "only-file.ts"), "export {};");

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES)).toBe(join("lib", "only-file.ts"));
	});

	it("scans deterministically (alphabetically), not in arbitrary directory-listing order", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "zzz.ts"), "export {};");
		writeFileSync(join(dir, "aaa.ts"), "export {};");

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES)).toBe("aaa.ts");
	});

	it("skips node_modules, dist, build, and hidden directories during the fallback scan", () => {
		const dir = freshRoot();
		mkdirSync(join(dir, "node_modules", "some-dep"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "some-dep", "index.ts"), "export {};");
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "dist", "bundle.js"), "export {};");
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, ".git", "config.ts"), "export {};");
		mkdirSync(join(dir, "lib"), { recursive: true });
		writeFileSync(join(dir, "lib", "real.ts"), "export {};");

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES)).toBe(join("lib", "real.ts"));
	});

	it("does not descend past its bounded scan depth", () => {
		const dir = freshRoot();
		// One level past MAX_SCAN_DEPTH (4): a/b/c/d/e/too-deep.ts should not be found.
		const deepDir = join(dir, "a", "b", "c", "d", "e");
		mkdirSync(deepDir, { recursive: true });
		writeFileSync(join(deepDir, "too-deep.ts"), "export {};");

		expect(() => discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES)).toThrow(NoSeedFileFound);
	});

	it("throws NoSeedFileFound when no source file exists at all", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "README.md"), "# nothing here");

		expect(() => discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES)).toThrow(NoSeedFileFound);
	});

	it("uses a different language's own extensions and candidates when given them", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "main.py"), "print('hi')");

		expect(discoverSeedFile(dir, [".py"], ["main.py"])).toBe("main.py");
	});
});
