/**
 * populateSymbolGraph against a real typescript-language-server + a real
 * InMemorySymbolGraph: proves the graph actually answers the multi-hop
 * question a flat edge list can't -- reachableFrom at depth 1 stops one hop
 * short of a transitive callee that depth 2 reaches.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import { LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import type { CodeIntelligencePort } from "../../src/ports/code-intelligence-port.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { populateSymbolGraph } from "../../src/symbol-graph/populate-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import { findPositionOf } from "../support/find-position.ts";

let fixtureRoot: string | undefined;
let index: LspSymbolIndex | undefined;
let graph: InMemorySymbolGraph | undefined;

afterEach(async () => {
	await index?.close();
	index = undefined;
	await graph?.close();
	graph = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): { root: string; chainFile: string; classFile: string } {
	const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-fixture-"));
	writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	const chainFile = join(root, "chain.ts");
	writeFileSync(
		chainFile,
		"export function a(): number {\n\treturn b();\n}\n\nexport function b(): number {\n\treturn c();\n}\n\nexport function c(): number {\n\treturn 42;\n}\n",
	);
	const classFile = join(root, "greeter.ts");
	writeFileSync(classFile, 'export class Greeter {\n\tgreet(): string {\n\t\treturn "hi";\n\t}\n}\n');
	return { root, chainFile, classFile };
}

describe("populateSymbolGraph", () => {
	it("builds a real 'calls' chain a real symbol graph can answer multi-hop questions about", async () => {
		const { root, chainFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [chainFile], 50);

		expect(result.filesProcessed).toBe(1);
		expect(result.symbolsProcessed).toBe(3);
		expect(result.edgesAdded).toBeGreaterThan(0);

		const aPosition = findPositionOf(chainFile, "export function a");
		const aId = deriveSymbolNodeId({ path: chainFile, line: aPosition.line, character: aPosition.character + "export function ".length });

		const oneHop = await graph.reachableFrom(aId, { maxDepth: 1, kind: "calls" });
		const twoHops = await graph.reachableFrom(aId, { maxDepth: 2, kind: "calls" });

		const oneHopNames = await Promise.all(oneHop.map(async (id) => (await graph?.getNode(id))?.name));
		const twoHopNames = await Promise.all(twoHops.map(async (id) => (await graph?.getNode(id))?.name));

		expect(oneHopNames).toContain("b");
		expect(oneHopNames).not.toContain("c");
		expect(twoHopNames).toContain("b");
		expect(twoHopNames).toContain("c");
	}, 20_000);

	it("adds a 'contains' edge from a class to its method, at no extra LSP cost", async () => {
		const { root, classFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		await populateSymbolGraph(index, graph, [classFile], 50);

		const classPosition = findPositionOf(classFile, "export class Greeter");
		const classId = deriveSymbolNodeId({ path: classFile, line: classPosition.line, character: classPosition.character + "export class ".length });

		const contained = await graph.edgesFrom(classId, "contains");
		const containedNames = await Promise.all(contained.map(async (id) => (await graph?.getNode(id))?.name));

		expect(containedNames).toContain("greet");
	}, 20_000);

	it("bounds recorded file failures while retaining the total failure count", async () => {
		const empty = async () => [];
		const failing: CodeIntelligencePort = {
			provenance: {
				fidelity: "semantic",
				backend: "failing-test-server",
				languageId: "test",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
			goToDefinition: empty,
			goToImplementation: empty,
			findReferences: empty,
			hover: async () => undefined,
			documentSymbols: async (path) => {
				throw new Error(`cannot index ${path}`);
			},
			diagnostics: empty,
			prepareCallHierarchy: empty,
			incomingCalls: empty,
			outgoingCalls: empty,
		};
		graph = new InMemorySymbolGraph();
		const files = Array.from({ length: 105 }, (_, position) => `/repo/file-${position}.test`);

		const result = await populateSymbolGraph(failing, graph, files, 10);

		expect(result).toMatchObject({ completeness: "partial", filesAttempted: 105, filesProcessed: 0, filesFailed: 105, failureCount: 105 });
		expect(result.failures).toHaveLength(100);
		expect(result.failuresTruncated).toBe(true);
		expect(result.failures[0]?.message.length).toBeLessThanOrEqual(500);
	});

	it("crawls many real cross-file-calling files fast, without paying the interactive settle wait per file", async () => {
		// Encodes a real, measured finding, not an assumption: real fixtures (25 and 53
		// files, both with genuine cross-file outgoingCalls resolution) produced
		// byte-identical results at zero settle versus the descriptor's normal 2000ms
		// default, a 50-60x wall-clock speedup. This test uses the REAL, unmodified
		// TYPESCRIPT_DESCRIPTOR (settleMs: 2000) specifically so it also proves
		// populateSymbolGraph's own override is actually wired -- if it silently
		// regressed back to the descriptor's default, this test's own elapsed-time
		// assertion below would fail, not just run slower unnoticed.
		const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-fast-crawl-"));
		fixtureRoot = root;
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		const fileCount = 10;
		const files: string[] = [];
		for (let n = 0; n < fileCount; n++) {
			const next = n + 1;
			const body =
				next < fileCount
					? `import { fn${next} } from "./f${next}.ts";\nexport function fn${n}(x: number): number {\n\treturn fn${next}(x) + 1;\n}\n`
					: `export function fn${n}(x: number): number {\n\treturn x;\n}\n`;
			const file = join(root, `f${n}.ts`);
			writeFileSync(file, body);
			files.push(file);
		}
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "f0.ts");
		graph = new InMemorySymbolGraph();

		const startedAt = performance.now();
		const result = await populateSymbolGraph(index, graph, files, 50);
		const elapsedMs = performance.now() - startedAt;

		expect(result.completeness).toBe("complete");
		expect(result.filesFailed).toBe(0);
		expect(result.filesProcessed).toBe(fileCount);
		expect(result.symbolsProcessed).toBe(fileCount);
		expect(result.edgesAdded).toBe(fileCount - 1); // one "calls" edge per link in the chain

		// The old per-file-settle behavior would need at least fileCount * descriptor.settleMs
		// (10 * 2000ms = 20s) just in sleep time, before any real LSP round trip. A generous
		// but still discriminating bound: real, validated fast behavior finishes in low single
		// digit seconds even under real test-runner load.
		expect(elapsedMs).toBeLessThan(15_000);
	}, 30_000);

	it("releases each file after processing it, so a bulk crawl over more files than the open-file cap fully succeeds", async () => {
		// Reproduces the real bug in miniature: 5 real files against a 2-slot open-file cap. Before
		// releaseFile existed, this failed partway through with LanguageFileLimitExceeded and never
		// recovered even for a live retry -- the exact failure mode found live against Lector's own
		// ~270-file monorepo.
		const root = mkdtempSync(join(tmpdir(), "lector-symbol-graph-release-"));
		fixtureRoot = root;
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		const files: string[] = [];
		for (let n = 0; n < 5; n++) {
			const file = join(root, `f${n}.ts`);
			writeFileSync(file, `export function fn${n}(): number {\n\treturn ${n};\n}\n`);
			files.push(file);
		}
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "f0.ts", { maxOpenFiles: 2 });
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, files, 50);

		expect(result.completeness).toBe("complete");
		expect(result.filesFailed).toBe(0);
		expect(result.filesProcessed).toBe(5);

		// The live-recovery promise this was breaking: a query against any of the files afterward
		// still works, proving the index isn't left permanently wedged at the cap.
		const symbols = await index.documentSymbols(files[4] ?? "");
		expect(symbols.some((entry) => entry.name === "fn4")).toBe(true);
	}, 30_000);

	it("calls releaseFile exactly once per attempted file, even when document-symbols or outgoing-calls fails", async () => {
		const released: string[] = [];
		let callCount = 0;
		const flaky: CodeIntelligencePort = {
			provenance: {
				fidelity: "semantic",
				backend: "flaky-test-server",
				languageId: "test",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async (path) => {
				callCount++;
				if (path === "/repo/fails.test") throw new Error("cannot index this one");
				return [];
			},
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			releaseFile: async (path) => {
				released.push(path);
			},
		};
		graph = new InMemorySymbolGraph();

		await populateSymbolGraph(flaky, graph, ["/repo/ok.test", "/repo/fails.test"], 10);

		expect(callCount).toBe(2);
		expect(released).toEqual(["/repo/ok.test", "/repo/fails.test"]);
	});

	function recordingLogger(): { logger: Logger; calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
		const calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
		return {
			calls,
			logger: {
				debug: (msg, fields) => calls.push({ level: "debug", msg, fields }),
				info: (msg, fields) => calls.push({ level: "info", msg, fields }),
				warn: (msg, fields) => calls.push({ level: "warn", msg, fields }),
				error: (msg, fields) => calls.push({ level: "error", msg, fields }),
			},
		};
	}

	function flakyPort(shouldFail: (path: string) => boolean): CodeIntelligencePort {
		return {
			provenance: {
				fidelity: "semantic",
				backend: "flaky-test-server",
				languageId: "test",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async (path) => {
				if (shouldFail(path)) throw new Error("cannot index this one");
				return [];
			},
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			releaseFile: async () => {},
		};
	}

	it("logs a warn per failed file as it happens, with path/operation/code/message", async () => {
		const { logger, calls } = recordingLogger();
		graph = new InMemorySymbolGraph();

		await populateSymbolGraph(
			flakyPort((path) => path === "/repo/fails.test"),
			graph,
			["/repo/ok.test", "/repo/fails.test"],
			10,
			logger,
		);

		const failure = calls.find((call) => call.msg === "symbol graph population: file failed");
		expect(failure?.level).toBe("warn");
		expect(failure?.fields).toMatchObject({ path: "/repo/fails.test", operation: "document-symbols", message: "cannot index this one" });
	});

	it("logs an info summary when every file succeeds, a warn summary when any fails", async () => {
		const clean = recordingLogger();
		graph = new InMemorySymbolGraph();
		await populateSymbolGraph(
			flakyPort(() => false),
			graph,
			["/repo/ok.test"],
			10,
			clean.logger,
		);
		const cleanSummary = clean.calls.find((call) => call.msg === "symbol graph population complete");
		expect(cleanSummary?.level).toBe("info");

		const dirty = recordingLogger();
		graph = new InMemorySymbolGraph();
		await populateSymbolGraph(
			flakyPort((path) => path === "/repo/fails.test"),
			graph,
			["/repo/ok.test", "/repo/fails.test"],
			10,
			dirty.logger,
		);
		const dirtySummary = dirty.calls.find((call) => call.msg === "symbol graph population completed with failures");
		expect(dirtySummary?.level).toBe("warn");
		expect(dirtySummary?.fields).toMatchObject({ filesAttempted: 2, filesProcessed: 1, filesFailed: 1, failureCount: 1 });
	});

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** documentSymbols takes a real delay, so concurrent vs. sequential dispatch is observable via timing and an in-flight counter, without a real LSP process. */
	function delayedPort(delayMs: number, maxInFlight: { current: number; peak: number }): CodeIntelligencePort {
		return {
			provenance: {
				fidelity: "semantic",
				backend: "delayed-test-server",
				languageId: "test",
				authority: "language-server",
				freshness: "live-process",
				limitations: [],
			},
			goToDefinition: async () => [],
			goToImplementation: async () => [],
			findReferences: async () => [],
			hover: async () => undefined,
			documentSymbols: async () => {
				maxInFlight.current++;
				maxInFlight.peak = Math.max(maxInFlight.peak, maxInFlight.current);
				await delay(delayMs);
				maxInFlight.current--;
				return [];
			},
			diagnostics: async () => [],
			prepareCallHierarchy: async () => [],
			incomingCalls: async () => [],
			outgoingCalls: async () => [],
			releaseFile: async () => {},
		};
	}

	it("defaults to strictly sequential dispatch (concurrency omitted): never more than one file in flight at once", async () => {
		graph = new InMemorySymbolGraph();
		const inFlight = { current: 0, peak: 0 };
		const files = Array.from({ length: 6 }, (_, n) => `/repo/file-${n}.test`);

		const result = await populateSymbolGraph(delayedPort(20, inFlight), graph, files, 10);

		expect(result.filesProcessed).toBe(6);
		expect(inFlight.peak).toBe(1);
	});

	it("dispatches up to `concurrency` files at once, and never more, finishing meaningfully faster than sequential", async () => {
		graph = new InMemorySymbolGraph();
		const inFlight = { current: 0, peak: 0 };
		const fileCount = 20;
		const delayMs = 20;
		const concurrency = 5;
		const files = Array.from({ length: fileCount }, (_, n) => `/repo/file-${n}.test`);

		const startedAt = performance.now();
		const result = await populateSymbolGraph(delayedPort(delayMs, inFlight), graph, files, 10, undefined, concurrency);
		const elapsedMs = performance.now() - startedAt;

		expect(result.filesProcessed).toBe(fileCount);
		expect(inFlight.peak).toBeLessThanOrEqual(concurrency);
		expect(inFlight.peak).toBeGreaterThan(1);

		// Theoretical batched minimum: (fileCount / concurrency) * delayMs. 2x margin for overhead.
		const theoreticalBatchedMs = (fileCount / concurrency) * delayMs;
		expect(elapsedMs).toBeLessThan(theoreticalBatchedMs * 2);
	});

	it("rejects a non-positive or non-integer concurrency rather than silently misbehaving", async () => {
		graph = new InMemorySymbolGraph();
		await expect(populateSymbolGraph(delayedPort(1, { current: 0, peak: 0 }), graph, [], 10, undefined, 0)).rejects.toThrow(/concurrency/);
		await expect(populateSymbolGraph(delayedPort(1, { current: 0, peak: 0 }), graph, [], 10, undefined, 1.5)).rejects.toThrow(/concurrency/);
	});

	it("returns honest zero counts for an empty file list, not an error", async () => {
		const { root } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "chain.ts");
		graph = new InMemorySymbolGraph();

		const result = await populateSymbolGraph(index, graph, [], 50);

		expect(result).toEqual({
			completeness: "complete",
			filesAttempted: 0,
			filesProcessed: 0,
			filesFailed: 0,
			symbolsProcessed: 0,
			nodesAdded: 0,
			edgesAdded: 0,
			failureCount: 0,
			failures: [],
			failuresTruncated: false,
		});
	}, 20_000);
});
