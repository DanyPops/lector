/**
 * refineTypescriptSeedFile against a real, synthetic monorepo fixture reproducing the exact
 * shape of a real bug found live against this project's own repo: a bounded directory scan can
 * pick a candidate whose nearest tsconfig.json ancestor exists but does not actually cover it
 * (its own include/exclude excludes that file), leaving workspace/symbol silently searching an
 * unrelated, near-empty inferred project. Uses the real `typescript` package -- no mocked
 * compiler API.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refineTypescriptSeedFile } from "../../../src/code-intelligence/lsp/typescript-project-files.ts";

function buildMonorepoFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-ts-project-files-"));
	// No root tsconfig.json -- matches this project's own monorepo shape.
	mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
	mkdirSync(join(root, "packages", "app", "benchmarks"), { recursive: true });
	writeFileSync(join(root, "packages", "app", "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", target: "ESNext" }, include: ["src"] }));
	writeFileSync(join(root, "packages", "app", "src", "index.ts"), "export function realExport() {}\n");
	// Has a real tsconfig.json ancestor (packages/app/tsconfig.json), but that config's own
	// include: ["src"] does not cover this file -- exactly the case that slipped through the
	// generic ancestor-marker heuristic alone.
	writeFileSync(join(root, "packages", "app", "benchmarks", "not-covered.ts"), "export function neverIndexed() {}\n");
	return root;
}

describe("refineTypescriptSeedFile", () => {
	it("replaces a candidate a real tsconfig.json does not actually include with a file that IS included", () => {
		const root = buildMonorepoFixture();
		try {
			const refined = refineTypescriptSeedFile(root, join("packages", "app", "benchmarks", "not-covered.ts"));
			expect(refined).toBe(join("packages", "app", "src", "index.ts"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a candidate unchanged when it is already covered by its nearest tsconfig", () => {
		const root = buildMonorepoFixture();
		try {
			const covered = join("packages", "app", "src", "index.ts");
			expect(refineTypescriptSeedFile(root, covered)).toBe(covered);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns the original candidate unchanged when no tsconfig.json exists anywhere", () => {
		const root = mkdtempSync(join(tmpdir(), "lector-ts-project-files-"));
		try {
			mkdirSync(join(root, "scripts"), { recursive: true });
			writeFileSync(join(root, "scripts", "standalone.ts"), "export {};\n");
			expect(refineTypescriptSeedFile(root, join("scripts", "standalone.ts"))).toBe(join("scripts", "standalone.ts"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
