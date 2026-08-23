import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { generateTypeScriptWorkloadCorpus } from "../../benchmarks/harness/workload-corpus.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function countFiles(dir: string): number {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
		else count += 1;
	}
	return count;
}

describe("generateTypeScriptWorkloadCorpus", () => {
	it("generates exactly the requested number of source files, plus a tsconfig.json", () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 1, fileCount: 12, shape: "independent" });
		root = corpus.rootPath;

		expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
		expect(corpus.files).toHaveLength(12);
		for (const file of corpus.files) expect(existsSync(join(root, file.relativePath))).toBe(true);
	});

	it("never exceeds the requested maxBytesPerFile bound", () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 2, fileCount: 5, shape: "independent", maxBytesPerFile: 500 });
		root = corpus.rootPath;

		for (const file of corpus.files) {
			const bytes = statSync(join(root, file.relativePath)).size;
			expect(bytes).toBeLessThanOrEqual(500);
		}
	});

	it("is fully deterministic: the same seed produces byte-identical files and the same symbol manifest", () => {
		const first = generateTypeScriptWorkloadCorpus({ seed: 42, fileCount: 8, shape: "chain" });
		const second = generateTypeScriptWorkloadCorpus({ seed: 42, fileCount: 8, shape: "chain" });
		root = first.rootPath;
		try {
			expect(second.files).toEqual(first.files);
			for (const file of first.files) {
				const a = readFileSync(join(first.rootPath, file.relativePath), "utf-8");
				const b = readFileSync(join(second.rootPath, file.relativePath), "utf-8");
				expect(b).toBe(a);
			}
		} finally {
			rmSync(second.rootPath, { recursive: true, force: true });
		}
	});

	it("produces a different corpus for a different seed", () => {
		const first = generateTypeScriptWorkloadCorpus({ seed: 1, fileCount: 8, shape: "chain" });
		const second = generateTypeScriptWorkloadCorpus({ seed: 2, fileCount: 8, shape: "chain" });
		root = first.rootPath;
		try {
			expect(second.files.map((f) => f.exportedSymbol)).not.toEqual(first.files.map((f) => f.exportedSymbol));
		} finally {
			rmSync(second.rootPath, { recursive: true, force: true });
		}
	});

	it("'chain' shape: each file (except the last) imports and calls into the next, forming one real cross-file call graph", () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 3, fileCount: 4, shape: "chain" });
		root = corpus.rootPath;

		for (let i = 0; i < corpus.files.length - 1; i++) {
			const file = corpus.files[i];
			const nextFile = corpus.files[i + 1];
			if (!file || !nextFile) throw new Error("corpus generation is expected to produce a contiguous file list");
			const content = readFileSync(join(root, file.relativePath), "utf-8");
			expect(content).toContain(nextFile.exportedSymbol);
		}
	});

	it("'independent' shape: no file references another file's symbol", () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 4, fileCount: 6, shape: "independent" });
		root = corpus.rootPath;

		const allSymbols = corpus.files.map((f) => f.exportedSymbol);
		for (const file of corpus.files) {
			const content = readFileSync(join(root, file.relativePath), "utf-8");
			for (const symbol of allSymbols) {
				if (symbol === file.exportedSymbol) continue;
				expect(content).not.toContain(symbol);
			}
		}
	});

	it("rejects a non-positive fileCount rather than silently generating an empty or unbounded corpus", () => {
		expect(() => generateTypeScriptWorkloadCorpus({ seed: 1, fileCount: 0, shape: "independent" })).toThrow();
		expect(() => generateTypeScriptWorkloadCorpus({ seed: 1, fileCount: -1, shape: "independent" })).toThrow();
	});

	it("total generated file count on disk matches the manifest exactly (no stray files)", () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 5, fileCount: 10, shape: "chain" });
		root = corpus.rootPath;
		expect(countFiles(root)).toBe(corpus.files.length + 1); // +1 for tsconfig.json
	});
});
