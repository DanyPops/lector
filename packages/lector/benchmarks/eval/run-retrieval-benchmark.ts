/**
 * The hybrid-retrieval benchmark itself (efe48de0/3cf2e918): runs every real Lector retrieval
 * method -- lexical (ripgrep), symbol-name (LSP workspace symbol search), graph (persisted
 * symbol-graph traversal), annotation (agent-authored free-text search), and a naive
 * union-of-all "combined" prototype -- against the hand-verified ground-truth corpus, and scores
 * each via recall@k/MRR at both file and (where expressible) exact-symbol granularity.
 *
 * No live LLM calls: recall/MRR is answerable directly and deterministically from each backend's
 * own real output, matching this project's own established benchmark discipline (see Doc
 * "Decision: Zoekt vs xgrep vs FFF..." -- measured engineering numbers, not an LLM trial matrix).
 * Response byte size per method per task is reported alongside recall/MRR as the token-efficiency
 * proxy the epic's own outcome text calls for ("bytes/tokens returned").
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";
import { populateSymbolGraph } from "../../src/symbol-graph/populate-symbol-graph.ts";
import { deriveSymbolNodeId } from "../../src/symbol-graph/symbol-node-id.ts";
import { InMemorySymbolAnnotations } from "../../src/symbol-annotation/in-memory-symbol-annotations.ts";
import { findSourceFiles } from "../../src/text-search/find-source-files.ts";
import { RipgrepTextSearch } from "../../src/text-search/ripgrep-text-search.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "../../test/support/typescript-reference-fixture.ts";
import { findPositionOf } from "../../test/support/find-position.ts";
import { RETRIEVAL_BENCHMARK_QUERIES, SEED_ANNOTATIONS } from "./retrieval-benchmark-queries.ts";
import { GROUND_TRUTH_CORPUS, type GroundTruthTask } from "./ground-truth-corpus.ts";
import { annotationRetrieve, combinedRetrieve, graphRetrieve, lexicalRetrieve, type RetrievedResult, symbolRetrieve } from "./retrieval-methods.ts";
import { scoreGroundTruthTask, scoreGroundTruthTaskByPath } from "./retrieval-scoring.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_SYMBOLS_PER_FILE = 200;

export interface MethodTaskResult {
	readonly resultCount: number;
	readonly responseBytes: number;
	readonly fileRecallAtK: number;
	readonly fileMrr: number;
	readonly symbolRecallAtK?: number;
	readonly symbolMrr?: number;
}

export interface TaskReport {
	readonly taskId: string;
	readonly category: GroundTruthTask["category"];
	readonly methods: Readonly<Record<string, MethodTaskResult>>;
}

export interface MethodAggregate {
	readonly meanFileRecallAtK: number;
	readonly meanFileMrr: number;
	readonly meanSymbolRecallAtK?: number;
	readonly meanSymbolMrr?: number;
}

export interface RetrievalBenchmarkReport {
	readonly k: number;
	readonly maxGraphDepth: number;
	readonly tasks: readonly TaskReport[];
	readonly aggregateByMethod: Readonly<Record<string, MethodAggregate>>;
	readonly aggregateByCategoryAndMethod: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface RunRetrievalBenchmarkOptions {
	readonly k: number;
	readonly maxGraphDepth: number;
}

/** Absolute LSP/annotation paths and workspace-relative ripgrep paths both become fixture-root-relative here, matching the corpus's own relative paths. */
function relativizeResult(root: string, result: RetrievedResult): RetrievedResult {
	const toRelative = (path: string): string => (path.startsWith(root) ? relative(root, path) : path);
	return {
		paths: result.paths.map(toRelative),
		...(result.symbolKeys !== undefined && {
			symbolKeys: result.symbolKeys.map((key) => {
				const hashIndex = key.indexOf("#");
				const path = hashIndex === -1 ? key : key.slice(0, hashIndex);
				const name = hashIndex === -1 ? "" : key.slice(hashIndex + 1);
				return `${toRelative(path)}#${name}`;
			}),
		}),
	};
}

function responseByteSize(result: RetrievedResult): number {
	return Buffer.byteLength(JSON.stringify(result), "utf-8");
}

function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function seedAnnotations(root: string): Promise<InMemorySymbolAnnotations> {
	const store = new InMemorySymbolAnnotations();
	for (const spec of SEED_ANNOTATIONS) {
		const absolutePath = join(root, spec.path);
		const position = findPositionOf(absolutePath, spec.symbolNeedle);
		const location = { path: absolutePath, line: position.line, character: position.character };
		const content = readFileSync(absolutePath, "utf-8");
		await store.create({
			subtype: "benchmark-seed",
			title: spec.title,
			body: spec.body,
			anchors: [{ symbolNodeId: deriveSymbolNodeId(location), path: absolutePath, fileContentHash: contentHashOf(content) }],
		});
	}
	return store;
}

export async function runRetrievalBenchmark(options: RunRetrievalBenchmarkOptions): Promise<RetrievalBenchmarkReport> {
	let fixture: TypeScriptReferenceFixture | undefined;
	let index: LspSymbolIndex | undefined;
	let graph: InMemorySymbolGraph | undefined;
	let annotations: InMemorySymbolAnnotations | undefined;
	try {
		fixture = materializeTypeScriptReferenceFixture();
		const root = fixture.root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "packages/app/src/main.ts");
		const textSearch = new RipgrepTextSearch();
		graph = new InMemorySymbolGraph();

		const relativeFiles = findSourceFiles(root, (extension) => SOURCE_EXTENSIONS.has(extension), 500);
		await populateSymbolGraph(
			index,
			graph,
			relativeFiles.map((relativePath) => join(root, relativePath)),
			MAX_SYMBOLS_PER_FILE,
		);
		// populateSymbolGraph releases (closes) every file once processed, including the seed file --
		// workspace/symbol search needs at least one open, project-attached file, so re-open the seed
		// before running any symbol/graph query below.
		await index.documentSymbols(join(root, "packages/app/src/main.ts"));
		annotations = await seedAnnotations(root);

		const tasks: TaskReport[] = [];
		for (const task of GROUND_TRUTH_CORPUS) {
			const query = RETRIEVAL_BENCHMARK_QUERIES.find((entry) => entry.taskId === task.id);
			if (!query) throw new Error(`no retrieval-benchmark query registered for ground-truth task "${task.id}"`);

			const lexical = relativizeResult(root, await lexicalRetrieve(textSearch, root, query.lexicalQuery, options.k));
			const symbol = relativizeResult(root, await symbolRetrieve(index, query.symbolQuery, options.k));
			const graphResult = relativizeResult(root, await graphRetrieve(index, graph, query.graphSeedQuery, options.maxGraphDepth, options.k));
			const annotation = relativizeResult(root, await annotationRetrieve(annotations, query.annotationQuery, options.k));
			const combined = combinedRetrieve(lexical, symbol, graphResult, annotation);

			const methodResults: Record<string, RetrievedResult> = { lexical, symbol, graph: graphResult, annotation, combined };
			const methods: Record<string, MethodTaskResult> = {};
			for (const [method, result] of Object.entries(methodResults)) {
				const fileScore = scoreGroundTruthTaskByPath(task, method, result.paths, options.k);
				const symbolScore = result.symbolKeys !== undefined ? scoreGroundTruthTask(task, method, result.symbolKeys, options.k) : undefined;
				methods[method] = {
					resultCount: result.paths.length,
					responseBytes: responseByteSize(result),
					fileRecallAtK: fileScore.recallAtK,
					fileMrr: fileScore.mrr,
					...(symbolScore !== undefined && { symbolRecallAtK: symbolScore.recallAtK, symbolMrr: symbolScore.mrr }),
				};
			}
			tasks.push({ taskId: task.id, category: task.category, methods });
		}

		const methodNames = ["lexical", "symbol", "graph", "annotation", "combined"];
		const aggregateByMethod: Record<string, MethodAggregate> = {};
		for (const method of methodNames) {
			const perTask = tasks.map((task) => task.methods[method]).filter((result): result is MethodTaskResult => result !== undefined);
			const symbolCapable = perTask.filter((result) => result.symbolRecallAtK !== undefined);
			aggregateByMethod[method] = {
				meanFileRecallAtK: mean(perTask.map((result) => result.fileRecallAtK)),
				meanFileMrr: mean(perTask.map((result) => result.fileMrr)),
				...(symbolCapable.length > 0 && {
					meanSymbolRecallAtK: mean(symbolCapable.map((result) => result.symbolRecallAtK ?? 0)),
					meanSymbolMrr: mean(symbolCapable.map((result) => result.symbolMrr ?? 0)),
				}),
			};
		}

		const categories = [...new Set(tasks.map((task) => task.category))];
		const aggregateByCategoryAndMethod: Record<string, Record<string, number>> = {};
		for (const category of categories) {
			const tasksInCategory = tasks.filter((task) => task.category === category);
			const byMethod: Record<string, number> = {};
			for (const method of methodNames) {
				byMethod[method] = mean(
					tasksInCategory.map((task) => task.methods[method]?.fileRecallAtK).filter((value): value is number => value !== undefined),
				);
			}
			aggregateByCategoryAndMethod[category] = byMethod;
		}

		return { k: options.k, maxGraphDepth: options.maxGraphDepth, tasks, aggregateByMethod, aggregateByCategoryAndMethod };
	} finally {
		await index?.close();
		await graph?.close();
		await annotations?.close();
		fixture?.dispose();
	}
}
