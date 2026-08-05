import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASH_DESCRIPTOR, PYTHON_DESCRIPTOR, TYPESCRIPT_DESCRIPTOR, YAML_DESCRIPTOR } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { discoverSeedFile, discoverWorkspaceDescriptors, NoSeedFileFound } from "../../../src/code-intelligence/lsp/discover-seed-file.ts";

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

describe("discoverWorkspaceDescriptors", () => {
	it("detects every enabled language and leaves explicit-only servers out of automatic fan-out", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "main.ts"), "export const value = 1;");
		writeFileSync(join(dir, "main.py"), "value = 1\n");
		writeFileSync(join(dir, "main.sh"), "echo ready\n");
		writeFileSync(join(dir, "data.yaml"), "ready: true\n");

		expect(
			discoverWorkspaceDescriptors(dir, [TYPESCRIPT_DESCRIPTOR, PYTHON_DESCRIPTOR, BASH_DESCRIPTOR, YAML_DESCRIPTOR]).map(
				({ descriptor }) => descriptor.languageId,
			),
		).toEqual(["typescript", "python"]);
	});
});

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

	it("prefers a candidate with a rootMarker ancestor over an alphabetically-earlier one with none -- a real bug found live against this project's own monorepo (a root-level eslint.config.ts alphabetically outranked every real project file)", () => {
		const dir = freshRoot();
		// Alphabetically first, but no tsconfig.json anywhere above it.
		writeFileSync(join(dir, "aaa-no-project.ts"), "export {};");
		// Alphabetically later, but has a real tsconfig.json ancestor.
		mkdirSync(join(dir, "zzz-real-project"), { recursive: true });
		writeFileSync(join(dir, "zzz-real-project", "tsconfig.json"), "{}");
		writeFileSync(join(dir, "zzz-real-project", "main.ts"), "export {};");

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES, ["tsconfig.json"])).toBe(join("zzz-real-project", "main.ts"));
	});

	it("falls back to the first alphabetical match when nothing scanned has a rootMarker ancestor", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "aaa.ts"), "export {};");
		writeFileSync(join(dir, "zzz.ts"), "export {};");

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES, ["tsconfig.json"])).toBe("aaa.ts");
	});

	it("treats rootPath itself having the marker as covering every file under it -- the ordinary single-package case must not regress", () => {
		const dir = freshRoot();
		writeFileSync(join(dir, "tsconfig.json"), "{}");
		writeFileSync(join(dir, "aaa.ts"), "export {};");

		expect(discoverSeedFile(dir, TS_EXTENSIONS, TS_COMMON_CANDIDATES, ["tsconfig.json"])).toBe("aaa.ts");
	});
});
