/**
 * A real bundler pulling in the bare "@danypops/lector" barrel for even one symbol drags in
 * that package's whole daemon/service/adapter surface too (Bun-only sqlite bindings, the real
 * typescript/pyright compilers, tree-sitter grammars, ...) -- confirmed broken for real
 * (esbuild's own bundling of typescript.js's dynamic `require("fs")` throws at runtime under
 * Node) before every barrel import in this package's own source was replaced with a deep,
 * leaf-module import. This is the static invariant that regression depends on: every runtime
 * import of `@danypops/lector` from this package's own source is a deep subpath into one small,
 * dependency-light leaf module, never the bare package specifier.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
const BARE_IMPORT = /from\s+["']@danypops\/lector["']/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return extname(entry.name) === ".ts" ? [path] : [];
	});
}

describe("no bare @danypops/lector barrel import", () => {
	it("only ever deep-imports a specific leaf module of @danypops/lector, never its full barrel", () => {
		const offenders = sourceFiles(SRC_DIR).filter((path) => BARE_IMPORT.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});
});
