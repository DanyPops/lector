#!/usr/bin/env bun
/**
 * Runs Bun tests with live console output plus authoritative JUnit timing, then emits bounded
 * human and machine reports by test, file, and operational layer.
 *
 * Usage: bun dev-tools/test-timing/run.ts [--top <n>] [--scope <scope>]
 *        [--json-out <path>] [--junit-out <path>] [bun test args/filters...]
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatTestTimingReport } from "./format-report.ts";
import { parseBunJunitReport } from "./parse-bun-junit.ts";
import { buildTestTimingReport, type TestTimingReport } from "./report.ts";
import { classifyTestLayer, type TestScope, testLayerIncludedInScope } from "./test-layer.ts";

const DEFAULT_TOP = 20;
const MAX_DISCOVERED_TEST_FILES = 2_000;
const SCOPES: readonly TestScope[] = ["all", "correctness", "evaluation", "performance"];

export interface TestTimingHarnessIo {
	readonly writeStdout: (chunk: string) => void;
	readonly writeStderr: (chunk: string) => void;
	readonly printReport: (text: string) => void;
}

export interface TestTimingMachineReport {
	readonly schemaVersion: 1;
	readonly scope: TestScope;
	readonly exitCode: number;
	readonly wallDurationMs: number;
	readonly report: TestTimingReport;
}

interface HarnessOptions {
	readonly top: number;
	readonly scope: TestScope;
	readonly jsonOut: string | undefined;
	readonly junitOut: string | undefined;
	readonly rest: readonly string[];
}

const REAL_IO: TestTimingHarnessIo = {
	writeStdout: (chunk) => process.stdout.write(chunk),
	writeStderr: (chunk) => process.stderr.write(chunk),
	printReport: (text) => console.log(text),
};

function optionValue(args: readonly string[], index: number, name: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
	return value;
}

/** Extracts harness flags before forwarding every remaining argument unchanged to Bun. */
function parseHarnessOptions(args: readonly string[]): HarnessOptions {
	let top = DEFAULT_TOP;
	let scope: TestScope = "all";
	let jsonOut: string | undefined;
	let junitOut: string | undefined;
	const rest: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--top") {
			top = Number(optionValue(args, index, "--top"));
			index++;
		} else if (argument === "--scope") {
			const value = optionValue(args, index, "--scope");
			if (!SCOPES.includes(value as TestScope)) throw new TypeError(`--scope must be one of ${SCOPES.join(", ")}`);
			scope = value as TestScope;
			index++;
		} else if (argument === "--json-out") {
			jsonOut = optionValue(args, index, "--json-out");
			index++;
		} else if (argument === "--junit-out") {
			junitOut = optionValue(args, index, "--junit-out");
			index++;
		} else if (argument !== undefined) {
			rest.push(argument);
		}
	}
	if (!Number.isSafeInteger(top) || top < 1) throw new TypeError("--top requires a positive integer");
	return { top, scope, jsonOut, junitOut, rest };
}

async function testFilesForScope(scope: TestScope): Promise<readonly string[]> {
	if (scope === "all") return [];
	const files = new Set<string>();
	for (const pattern of ["dev-tools/**/*.test.ts", "test/**/*.test.ts", "test/**/*.test.tsx"]) {
		for await (const file of new Bun.Glob(pattern).scan({ cwd: process.cwd(), onlyFiles: true })) {
			if (testLayerIncludedInScope(classifyTestLayer(file), scope)) files.add(file);
			if (files.size > MAX_DISCOVERED_TEST_FILES) throw new RangeError(`test scope exceeds ${MAX_DISCOVERED_TEST_FILES} files`);
		}
	}
	if (files.size === 0) throw new Error(`test scope "${scope}" selected no files`);
	return [...files].sort();
}

/** Mirrors a child stream live; JUnit remains the timing source, so stream ordering is irrelevant. */
async function mirror(stream: ReadableStream<Uint8Array>, sink: (chunk: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) sink(decoder.decode(chunk, { stream: true }));
}

function ensureParent(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

/** Runs the selected Bun tests and returns their real exit code plus authoritative timing report. */
export async function runInstrumentedTests(
	args: readonly string[],
	io: TestTimingHarnessIo = REAL_IO,
): Promise<{ exitCode: number; report: TestTimingReport }> {
	const options = parseHarnessOptions(args);
	const temporaryDirectory = options.junitOut ? undefined : mkdtempSync(join(tmpdir(), "lector-test-timing-"));
	const junitOut = options.junitOut ?? join(temporaryDirectory ?? tmpdir(), "junit.xml");
	ensureParent(junitOut);
	if (options.jsonOut) ensureParent(options.jsonOut);
	const selectedFiles = await testFilesForScope(options.scope);
	const startedAt = performance.now();
	try {
		const child = Bun.spawn(["bun", "test", ...selectedFiles, ...options.rest, "--reporter=junit", `--reporter-outfile=${junitOut}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, , exitCode] = await Promise.all([mirror(child.stdout, io.writeStdout), mirror(child.stderr, io.writeStderr), child.exited]);
		if (!existsSync(junitOut)) throw new Error(`Bun did not write JUnit report to ${junitOut}`);
		const entries = parseBunJunitReport(readFileSync(junitOut, "utf8"));
		const report = buildTestTimingReport(entries, { topSlowestTests: options.top, topSlowestFiles: options.top });
		const wallDurationMs = performance.now() - startedAt;
		const formattedReport = formatTestTimingReport(report);
		io.printReport(`\n${formattedReport}`);
		const githubSummary = process.env.GITHUB_STEP_SUMMARY;
		if (githubSummary) appendFileSync(githubSummary, `## Lector test timing\n\n\`\`\`text\n${formattedReport}\n\`\`\`\n`);
		if (options.jsonOut) {
			const machineReport: TestTimingMachineReport = { schemaVersion: 1, scope: options.scope, exitCode, wallDurationMs, report };
			await Bun.write(options.jsonOut, `${JSON.stringify(machineReport, undefined, 2)}\n`);
		}
		return { exitCode, report };
	} finally {
		if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const { exitCode } = await runInstrumentedTests(process.argv.slice(2));
	process.exit(exitCode);
}
