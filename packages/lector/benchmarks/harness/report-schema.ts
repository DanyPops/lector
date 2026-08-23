/**
 * Versioned, bounded JSON artifact schema for a benchmark run -- what actually gets written to
 * disk for later comparison/regression tracking. schemaVersion lets a future reader (or a CI
 * regression check) reject an artifact produced by an incompatible older/newer writer instead of
 * silently misinterpreting its shape.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkRunResult } from "./benchmark-runner.ts";
import type { EnvironmentMetadata } from "./environment.ts";

export const BENCHMARK_SCHEMA_VERSION = 1;

/** Generous but real: a benchmark artifact is a diagnostic record, not a database -- this bounds it the same way every other Lector output is bounded. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

export interface WorkloadDescriptor {
	/** A stable name for what was benchmarked, e.g. "ripgrep-vs-xgrep-cold-search" -- lets artifacts from different workloads never be compared against each other by accident. */
	readonly identity: string;
	/** Whatever bounds shaped this run (maxFiles, corpus size, maxMatches, ...) -- free-form since every workload's real bounds differ. */
	readonly bounds: Record<string, unknown>;
}

export interface BenchmarkComparisonSummary {
	readonly controlName: string;
	readonly candidateName: string;
	readonly speedupFactor: number | undefined;
}

export interface BenchmarkArtifact {
	readonly schemaVersion: number;
	/** ISO-8601 timestamp of when this artifact was generated. */
	readonly generatedAt: string;
	readonly environment: EnvironmentMetadata;
	readonly workload: WorkloadDescriptor;
	readonly cases: readonly BenchmarkRunResult[];
	readonly comparisons?: readonly BenchmarkComparisonSummary[];
}

export class BenchmarkArtifactTooLarge extends Error {
	constructor(
		readonly actualBytes: number,
		readonly maxBytes: number,
	) {
		super(`benchmark artifact is ${actualBytes} bytes, exceeding the ${maxBytes}-byte bound -- reduce sample count or per-sample detail before writing`);
		this.name = "BenchmarkArtifactTooLarge";
	}
}

/** Builds a schema-stamped, timestamped benchmark artifact from a run's real results. */
export function buildBenchmarkArtifact(input: {
	readonly environment: EnvironmentMetadata;
	readonly workload: WorkloadDescriptor;
	readonly cases: readonly BenchmarkRunResult[];
	readonly comparisons?: readonly BenchmarkComparisonSummary[];
}): BenchmarkArtifact {
	return {
		schemaVersion: BENCHMARK_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		environment: input.environment,
		workload: input.workload,
		cases: input.cases,
		...(input.comparisons ? { comparisons: input.comparisons } : {}),
	};
}

/** Writes `artifact` as pretty-printed JSON under `outputDir` (created if needed), named by workload identity and timestamp. Rejects outright, writing nothing, if the serialized artifact exceeds MAX_ARTIFACT_BYTES. */
export async function writeBenchmarkArtifact(artifact: BenchmarkArtifact, outputDir: string): Promise<string> {
	const json = JSON.stringify(artifact, null, 2);
	const bytes = Buffer.byteLength(json, "utf-8");
	if (bytes > MAX_ARTIFACT_BYTES) throw new BenchmarkArtifactTooLarge(bytes, MAX_ARTIFACT_BYTES);
	await mkdir(outputDir, { recursive: true });
	const safeIdentity = artifact.workload.identity.replace(/[^a-zA-Z0-9._-]/g, "_");
	const fileName = `${safeIdentity}-${artifact.generatedAt.replace(/[:.]/g, "-")}.json`;
	const path = join(outputDir, fileName);
	await writeFile(path, json, "utf-8");
	return path;
}
