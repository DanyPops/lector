import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkRunResult } from "../../benchmarks/harness/benchmark-runner.ts";
import type { EnvironmentMetadata } from "../../benchmarks/harness/environment.ts";
import { BENCHMARK_SCHEMA_VERSION, buildBenchmarkArtifact, MAX_ARTIFACT_BYTES, writeBenchmarkArtifact } from "../../benchmarks/harness/report-schema.ts";

const FAKE_ENVIRONMENT: EnvironmentMetadata = {
	gitCommit: "a".repeat(40),
	gitDirty: false,
	bunVersion: "1.0.0",
	platform: "linux",
	arch: "x64",
	cpuCount: 8,
	cpuModel: "fake cpu",
	totalMemoryBytes: 16_000_000_000,
	freeMemoryBytes: 8_000_000_000,
};

function fakeRunResult(name: string): BenchmarkRunResult {
	return {
		name,
		mode: "warm",
		warmupIterations: 2,
		requestedSampleIterations: 5,
		completedSampleIterations: 5,
		timedOut: false,
		cancelled: false,
		samples: [],
		wallTimeStatistics: { count: 5, min: 1, max: 2, mean: 1.5, median: 1.5, p50: 1.5, p90: 1.9, p95: 1.95, p99: 1.99, stddev: 0.3, relativeStdDevPercent: 20 },
		cpuUserStatistics: undefined,
		cpuSystemStatistics: undefined,
	};
}

let outputDir: string | undefined;
afterEach(() => {
	if (outputDir) rmSync(outputDir, { recursive: true, force: true });
	outputDir = undefined;
});

describe("buildBenchmarkArtifact", () => {
	it("stamps the current schema version and includes the given environment, workload identity, and cases", () => {
		const artifact = buildBenchmarkArtifact({
			environment: FAKE_ENVIRONMENT,
			workload: { identity: "unit-test-workload", bounds: { maxFiles: 100 } },
			cases: [fakeRunResult("case-a")],
		});

		expect(artifact.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
		expect(artifact.environment).toEqual(FAKE_ENVIRONMENT);
		expect(artifact.workload).toEqual({ identity: "unit-test-workload", bounds: { maxFiles: 100 } });
		expect(artifact.cases).toHaveLength(1);
		expect(typeof artifact.generatedAt).toBe("string");
		expect(() => new Date(artifact.generatedAt).toISOString()).not.toThrow();
	});

	it("includes an optional comparisons array when given", () => {
		const artifact = buildBenchmarkArtifact({
			environment: FAKE_ENVIRONMENT,
			workload: { identity: "unit-test-workload", bounds: {} },
			cases: [fakeRunResult("control"), fakeRunResult("candidate")],
			comparisons: [{ controlName: "control", candidateName: "candidate", speedupFactor: 2.5 }],
		});

		expect(artifact.comparisons).toEqual([{ controlName: "control", candidateName: "candidate", speedupFactor: 2.5 }]);
	});
});

describe("writeBenchmarkArtifact", () => {
	it("writes a real, parseable JSON file to the given output directory, creating it if needed", async () => {
		outputDir = join(mkdtempSync(join(tmpdir(), "lector-bench-artifact-")), "nested", "results");
		const artifact = buildBenchmarkArtifact({
			environment: FAKE_ENVIRONMENT,
			workload: { identity: "unit-test-workload", bounds: {} },
			cases: [fakeRunResult("case-a")],
		});

		const path = await writeBenchmarkArtifact(artifact, outputDir);

		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
		expect(parsed.workload.identity).toBe("unit-test-workload");
	});

	it("rejects an artifact that would exceed the bounded output size instead of writing an unbounded file", async () => {
		outputDir = mkdtempSync(join(tmpdir(), "lector-bench-artifact-huge-"));
		const hugeSamples = Array.from({ length: 500_000 }, (_, index) => ({
			index,
			wallTimeMs: 1,
			cpuUserMs: 1,
			cpuSystemMs: 1,
			rssBytesDelta: 1,
			heapUsedBytesDelta: 1,
			externalBytesDelta: 1,
			correctnessDigest: "x".repeat(200),
		}));
		const artifact = buildBenchmarkArtifact({
			environment: FAKE_ENVIRONMENT,
			workload: { identity: "huge-workload", bounds: {} },
			cases: [{ ...fakeRunResult("huge"), samples: hugeSamples }],
		});
		expect(JSON.stringify(artifact).length).toBeGreaterThan(MAX_ARTIFACT_BYTES);

		await expect(writeBenchmarkArtifact(artifact, outputDir)).rejects.toThrow();
	});
});
