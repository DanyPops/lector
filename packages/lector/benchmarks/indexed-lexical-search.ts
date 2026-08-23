/**
 * Measures cold index-build time, warm search latency, and index footprint for xgrep, FFF, and
 * zoekt against RipgrepTextSearch (Lector's current, unindexed baseline) over the same real,
 * deterministic corpus -- the evidence "Lector: benchmark Zoekt, xgrep, and FFF as durable
 * indexed lexical search backends" requires before any production adoption decision.
 * Run: `bun benchmarks/indexed-lexical-search.ts`.
 *
 * Deployment shape differs materially across the three and is itself part of what this measures,
 * not hidden: xgrep and FFF are in-process napi/FFI bindings (no extra process to manage); zoekt
 * has no npm package or JS binding at all and is shelled out to as two separate Go binaries
 * (zoekt-index, zoekt) this benchmark builds itself via `go install`.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RipgrepTextSearch } from "../src/text-search/ripgrep-text-search.ts";
import { runBenchmarkCase } from "./harness/benchmark-runner.ts";
import { collectEnvironmentMetadata } from "./harness/environment.ts";
import { formatBenchmarkResult } from "./harness/format-report.ts";
import { buildBenchmarkArtifact, writeBenchmarkArtifact } from "./harness/report-schema.ts";
import { generateTypeScriptWorkloadCorpus } from "./harness/workload-corpus.ts";
import { FffTextSearch } from "./text-search-prototypes/fff-text-search.ts";
import { XgrepTextSearch } from "./text-search-prototypes/xgrep-text-search.ts";
import { ZoektTextSearch } from "./text-search-prototypes/zoekt-text-search.ts";

const CORPUS_FILE_COUNT = 500;
const WARM_SEARCH_SAMPLES = 30;
const SEARCH_QUERY = "workloadFn"; // present in every generated file's exported symbol name -- a realistic "find every call site" query.

function directorySizeBytes(path: string): number {
	// A real `du` call, not a hand-rolled recursive walk -- this benchmark measures real on-disk
	// footprint, and du already correctly accounts for sparse files/hardlinks the way a hand
	// walk summing stat().size would not.
	const output = execSync(`du -sb ${JSON.stringify(path)}`, { encoding: "utf-8" });
	return Number.parseInt(output.split("\t")[0] ?? "0", 10);
}

async function main(): Promise<void> {
	const corpus = generateTypeScriptWorkloadCorpus({ seed: 42, fileCount: CORPUS_FILE_COUNT, shape: "independent" });
	console.log(`corpus: ${corpus.files.length} files at ${corpus.rootPath}`);

	const results: Record<string, unknown> = {};
	const runs: Awaited<ReturnType<typeof runBenchmarkCase>>[] = [];

	// --- Baseline: RipgrepTextSearch (fresh scan every call, no persistent index) ---
	{
		const ripgrep = new RipgrepTextSearch();
		const run = await runBenchmarkCase({
			name: "ripgrep-warm-search",
			mode: "warm",
			sampleIterations: WARM_SEARCH_SAMPLES,
			run: () => ripgrep.search(corpus.rootPath, SEARCH_QUERY, { maxMatches: 50, maxBytes: 65_536 }),
			resultBytes: (result) => result.matches.reduce((sum, match) => sum + Buffer.byteLength(match.line, "utf8"), 0),
		});
		runs.push(run);
		results.ripgrep = { coldBuildMs: 0, indexBytes: 0, warmSearchRun: run };
	}

	// --- xgrep: on-disk trigram index, in-process napi binding ---
	{
		const xgrep = new XgrepTextSearch();
		const coldStart = performance.now();
		xgrep.buildIndex(corpus.rootPath);
		const coldBuildMs = performance.now() - coldStart;
		const indexBytes = xgrep.indexSizeBytes(corpus.rootPath);
		const run = await runBenchmarkCase({
			name: "xgrep-warm-search",
			mode: "warm",
			sampleIterations: WARM_SEARCH_SAMPLES,
			run: () => xgrep.search(corpus.rootPath, SEARCH_QUERY, { maxMatches: 50, maxBytes: 65_536 }),
			resultBytes: (result) => result.matches.reduce((sum, match) => sum + Buffer.byteLength(match.line, "utf8"), 0),
		});
		runs.push(run);
		results.xgrep = { coldBuildMs, indexBytes, warmSearchRun: run };

		// Incremental update: touch one file, rebuild, measure -- xgrep's own hybrid mode means a
		// rebuild after a small change should be far cheaper than the cold build above.
		writeFileSync(join(corpus.rootPath, corpus.files[0]!.relativePath), "export function touched(): number { return 1; }\n");
		const incrementalStart = performance.now();
		xgrep.buildIndex(corpus.rootPath);
		(results.xgrep as Record<string, unknown>).incrementalUpdateMs = performance.now() - incrementalStart;
	}

	// --- FFF: in-memory resident index, background watcher, Bun-native FFI ---
	{
		const fff = new FffTextSearch();
		try {
			const rssBefore = process.memoryUsage().rss;
			const coldStart = performance.now();
			await fff.openAndScan(corpus.rootPath, 30_000);
			const coldBuildMs = performance.now() - coldStart;
			const residentRssDeltaBytes = process.memoryUsage().rss - rssBefore;
			const run = await runBenchmarkCase({
				name: "fff-warm-search",
				mode: "warm",
				sampleIterations: WARM_SEARCH_SAMPLES,
				run: () => fff.search(corpus.rootPath, SEARCH_QUERY, { maxMatches: 50, maxBytes: 65_536 }),
				resultBytes: (result) => result.matches.reduce((sum, match) => sum + Buffer.byteLength(match.line, "utf8"), 0),
			});
			runs.push(run);
			results.fff = { coldBuildMs, residentRssDeltaBytes, warmSearchRun: run };
		} finally {
			fff.destroyAll();
		}
	}

	// --- zoekt: on-disk shard index, out-of-process (no npm/JS binding exists) ---
	{
		const indexDir = mkdtempSync(join(tmpdir(), "lector-bench-zoekt-index-"));
		try {
			const zoekt = new ZoektTextSearch(indexDir);
			const coldStart = performance.now();
			await zoekt.buildIndex(corpus.rootPath);
			const coldBuildMs = performance.now() - coldStart;
			const indexBytes = directorySizeBytes(indexDir);
			const run = await runBenchmarkCase({
				name: "zoekt-warm-search",
				mode: "warm",
				sampleIterations: WARM_SEARCH_SAMPLES,
				run: () => zoekt.search(corpus.rootPath, SEARCH_QUERY, { maxMatches: 50, maxBytes: 65_536 }),
				resultBytes: (result) => result.matches.reduce((sum, match) => sum + Buffer.byteLength(match.line, "utf8"), 0),
			});
			runs.push(run);
			results.zoekt = { coldBuildMs, indexBytes, warmSearchRun: run };
		} finally {
			rmSync(indexDir, { recursive: true, force: true });
		}
	}

	console.table(
		Object.entries(results).map(([name, data]) => {
			const value = data as {
				coldBuildMs: number;
				indexBytes?: number;
				residentRssDeltaBytes?: number;
				incrementalUpdateMs?: number;
				warmSearchRun: Awaited<ReturnType<typeof runBenchmarkCase>>;
			};
			return {
				backend: name,
				"cold build (ms)": value.coldBuildMs.toFixed(0),
				"incremental update (ms)": value.incrementalUpdateMs !== undefined ? value.incrementalUpdateMs.toFixed(0) : "n/a",
				"disk index (KB)": value.indexBytes !== undefined ? (value.indexBytes / 1024).toFixed(0) : "n/a",
				"resident RSS delta (MB)": value.residentRssDeltaBytes !== undefined ? (value.residentRssDeltaBytes / (1024 * 1024)).toFixed(1) : "n/a",
				"warm search median (ms)": value.warmSearchRun.wallTimeStatistics?.median.toFixed(3) ?? "n/a",
				"warm search p95 (ms)": value.warmSearchRun.wallTimeStatistics?.p95.toFixed(3) ?? "n/a",
			};
		}),
	);

	for (const run of runs) console.log(`\n${formatBenchmarkResult(run)}`);

	const environment = await collectEnvironmentMetadata(join(import.meta.dir, ".."));
	const artifact = buildBenchmarkArtifact({
		environment,
		workload: { identity: "indexed-lexical-search", bounds: { fileCount: CORPUS_FILE_COUNT, warmSearchSamples: WARM_SEARCH_SAMPLES } },
		cases: runs,
	});
	const artifactPath = await writeBenchmarkArtifact(artifact, join(import.meta.dir, ".results"));
	console.log(`\nenvironment + workload metadata written to ${artifactPath}`);

	rmSync(corpus.rootPath, { recursive: true, force: true });
}

await main();
