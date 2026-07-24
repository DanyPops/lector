/**
 * Measures real cold-start (spawn through first correct documentSymbols
 * answer) and warm-query latency per LanguageServerDescriptor, against a
 * throwaway real project fixture per language -- not synthetic numbers.
 * Run: `bun benchmarks/language-server-cold-start.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/adapters/lsp/lsp-symbol-index.ts";
import { measureProcessTreeRssKb } from "../src/adapters/lsp/process-resource-usage.ts";
import { documentSymbols } from "../src/domain/document-symbols.ts";
import {
	BASH_DESCRIPTOR,
	CPP_DESCRIPTOR,
	GO_DESCRIPTOR,
	type LanguageServerDescriptor,
	PYTHON_DESCRIPTOR,
	RUST_DESCRIPTOR,
	TYPESCRIPT_DESCRIPTOR,
	YAML_DESCRIPTOR,
} from "../src/domain/language-server-descriptor.ts";

interface BenchmarkCase {
	readonly descriptor: LanguageServerDescriptor;
	readonly seedFile: string;
	buildRoot(): string;
}

const CASES: readonly BenchmarkCase[] = [
	{
		descriptor: TYPESCRIPT_DESCRIPTOR,
		seedFile: "main.ts",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-ts-"));
			writeFileSync(join(root, "main.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
			return root;
		},
	},
	{
		descriptor: PYTHON_DESCRIPTOR,
		seedFile: "main.py",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-py-"));
			writeFileSync(join(root, "main.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
			return root;
		},
	},
	{
		descriptor: GO_DESCRIPTOR,
		seedFile: "main.go",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-go-"));
			writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.22\n");
			writeFileSync(join(root, "main.go"), "package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n");
			return root;
		},
	},
	{
		descriptor: RUST_DESCRIPTOR,
		seedFile: "src/main.rs",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-rust-"));
			writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "src", "main.rs"), "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n");
			return root;
		},
	},
	{
		descriptor: CPP_DESCRIPTOR,
		seedFile: "main.cpp",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-cpp-"));
			writeFileSync(join(root, "main.cpp"), "int add(int a, int b) {\n    return a + b;\n}\n");
			return root;
		},
	},
	{
		descriptor: BASH_DESCRIPTOR,
		seedFile: "main.sh",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-bash-"));
			writeFileSync(join(root, "main.sh"), "add() {\n    echo $(( $1 + $2 ))\n}\n");
			return root;
		},
	},
	{
		descriptor: YAML_DESCRIPTOR,
		seedFile: "config.yaml",
		buildRoot: () => {
			const root = mkdtempSync(join(tmpdir(), "lector-bench-yaml-"));
			writeFileSync(join(root, "config.yaml"), "name: fixture\nversion: 1\n");
			return root;
		},
	},
];

interface BenchmarkResult {
	readonly languageId: string;
	readonly coldStartMs: number;
	readonly warmQueryMs: number;
	readonly rssMb: number | undefined;
}

async function runOne(benchCase: BenchmarkCase): Promise<BenchmarkResult> {
	const root = benchCase.buildRoot();
	const mainFile = join(root, benchCase.seedFile);
	const index = new LspSymbolIndex(root, benchCase.descriptor, benchCase.seedFile);
	try {
		const coldStart = performance.now();
		await documentSymbols(index, mainFile);
		const coldStartMs = performance.now() - coldStart;

		const warmStart = performance.now();
		await documentSymbols(index, mainFile);
		const warmQueryMs = performance.now() - warmStart;

		const pid = index.processId;
		const rssKb = pid !== undefined ? measureProcessTreeRssKb(pid) : undefined;

		return { languageId: benchCase.descriptor.languageId, coldStartMs, warmQueryMs, rssMb: rssKb !== undefined ? rssKb / 1024 : undefined };
	} finally {
		await index.close();
		rmSync(root, { recursive: true, force: true });
	}
}

const results: BenchmarkResult[] = [];
for (const benchCase of CASES) {
	// Sequential, not parallel: spawning every server's process at once would contend for the
	// same CPU cores and produce cold-start numbers that measure contention, not the server.
	results.push(await runOne(benchCase));
}

console.table(
	results.map((result) => ({
		language: result.languageId,
		"cold start (ms)": result.coldStartMs.toFixed(0),
		"warm query (ms)": result.warmQueryMs.toFixed(1),
		"RSS incl. children (MB)": result.rssMb !== undefined ? result.rssMb.toFixed(0) : "n/a",
	})),
);

const totalRssMb = results.reduce((sum, result) => sum + (result.rssMb ?? 0), 0);
console.log(`total RSS if every server ran concurrently: ${totalRssMb.toFixed(0)} MB`);
