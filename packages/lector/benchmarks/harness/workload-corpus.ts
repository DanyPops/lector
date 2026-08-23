/**
 * Deterministic, seeded, explicitly-bounded workload corpora for the performance/replay harness.
 * Generated corpora are never committed (see .gitignore) -- only the generator and its own tests
 * are. Every generator accepts an explicit seed (reproducibility) and explicit bounds
 * (fileCount, maxBytesPerFile) so a caller can scale a workload without any hidden default that
 * silently grows.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeededRandom } from "./seeded-random.ts";

export class InvalidCorpusBounds extends Error {
	constructor(readonly fileCount: number) {
		super(`fileCount must be a positive integer, got ${fileCount}`);
		this.name = "InvalidCorpusBounds";
	}
}

export type WorkloadCorpusShape = "independent" | "chain";

export interface WorkloadCorpusFile {
	readonly relativePath: string;
	/** The one top-level function this file exports -- the file's "ground truth" symbol for correctness verification during replay. */
	readonly exportedSymbol: string;
}

export interface WorkloadCorpus {
	readonly rootPath: string;
	readonly seed: number;
	readonly shape: WorkloadCorpusShape;
	readonly files: readonly WorkloadCorpusFile[];
}

export interface WorkloadCorpusOptions {
	readonly seed: number;
	readonly fileCount: number;
	readonly shape: WorkloadCorpusShape;
	/** Caps generated filler content -- the real file may be smaller once filler is trimmed to this bound, never larger. */
	readonly maxBytesPerFile?: number;
}

const DEFAULT_MAX_BYTES_PER_FILE = 4_096;

function symbolNameFor(random: () => number, index: number): string {
	// Deterministic but not sequential-looking -- derived from the seeded stream, not just `fn${index}`,
	// so a corpus reader can't accidentally rely on alphabetic/numeric ordering matching generation order.
	const suffix = Math.floor(random() * 1_000_000);
	return `workloadFn${index}_${suffix}`;
}

function buildFileContent(
	index: number,
	exportedSymbol: string,
	shape: WorkloadCorpusShape,
	nextFile: WorkloadCorpusFile | undefined,
	random: () => number,
	maxBytes: number,
): string {
	const callsNext = shape === "chain" && nextFile !== undefined;
	const importLine = callsNext ? `import { ${nextFile!.exportedSymbol} } from "./${nextFile!.relativePath.replace(/\.ts$/, "")}";\n\n` : "";
	const body = callsNext ? `\treturn ${nextFile!.exportedSymbol}(x) + ${index};\n` : `\treturn x + ${index};\n`;
	const header = `${importLine}export function ${exportedSymbol}(x: number): number {\n${body}}\n`;

	// Filler is a comment block, never affecting the real exported symbol/call shape above --
	// it exists purely to reach a target byte size deterministically, bounded by maxBytes.
	const remaining = Math.max(0, maxBytes - Buffer.byteLength(header, "utf-8"));
	if (remaining < 16) return header;
	const fillerLineLength = 60;
	const fillerLines: string[] = [];
	// Reserve one byte for the leading "\n" the filler block is joined onto the header with.
	let used = 1;
	while (used + fillerLineLength < remaining) {
		const token = Math.floor(random() * 1_000_000_000).toString(36);
		fillerLines.push(`// filler ${token.padEnd(fillerLineLength - 10, "0")}`);
		used += fillerLineLength + 1; // +1 for the "\n" joining this line to the next
	}
	return fillerLines.length > 0 ? `${header}\n${fillerLines.join("\n")}` : header;
}

/** Generates a real, on-disk, deterministic TypeScript project: `fileCount` files under a fresh temp directory with a tsconfig.json, in the requested shape. */
export function generateTypeScriptWorkloadCorpus(options: WorkloadCorpusOptions): WorkloadCorpus {
	if (!Number.isInteger(options.fileCount) || options.fileCount <= 0) throw new InvalidCorpusBounds(options.fileCount);
	const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
	const random = createSeededRandom(options.seed);

	const rootPath = mkdtempSync(join(tmpdir(), "lector-workload-corpus-"));
	writeFileSync(join(rootPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));

	const files: WorkloadCorpusFile[] = [];
	for (let i = 0; i < options.fileCount; i++) {
		files.push({ relativePath: `f${i}.ts`, exportedSymbol: symbolNameFor(random, i) });
	}

	for (let i = 0; i < files.length; i++) {
		const file = files[i] as WorkloadCorpusFile;
		const nextFile = i + 1 < files.length ? files[i + 1] : undefined;
		const content = buildFileContent(i, file.exportedSymbol, options.shape, nextFile, random, maxBytesPerFile);
		writeFileSync(join(rootPath, file.relativePath), content);
	}

	return { rootPath, seed: options.seed, shape: options.shape, files };
}
