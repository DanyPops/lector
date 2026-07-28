import type { Database } from "bun:sqlite";
import { type Migration, openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import type { IntelligenceProvenance } from "../domain/intelligence-provenance.ts";
import type { PopulateSymbolGraphResult, SymbolGraphPopulationFailure } from "../domain/populate-symbol-graph.ts";
import type { SymbolGraphGeneration } from "../domain/symbol-graph-generation.ts";
import type { SymbolNodeId } from "../domain/symbol-node-id.ts";
import type { SymbolEdgeKind, SymbolEdgeRecord, SymbolGraphPort, SymbolNode } from "../ports/symbol-graph-port.ts";

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		up: (db) => {
			db.exec(
				"CREATE TABLE symbol_nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, character INTEGER NOT NULL)",
			);
			db.exec("CREATE TABLE symbol_edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (from_id, to_id, kind))");
			db.exec("CREATE INDEX symbol_edges_to_idx ON symbol_edges (to_id, kind)");
		},
	},
	{
		version: 2,
		up: (db) => {
			db.exec(
				"CREATE TABLE symbol_graph_generation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), source_fingerprint TEXT NOT NULL, max_files INTEGER NOT NULL, max_symbols_per_file INTEGER NOT NULL, completed_at INTEGER NOT NULL, files_processed INTEGER NOT NULL, symbols_processed INTEGER NOT NULL, nodes_added INTEGER NOT NULL, edges_added INTEGER NOT NULL)",
			);
		},
	},
	{
		version: 3,
		up: (db) => db.exec("ALTER TABLE symbol_graph_generation ADD COLUMN provenance_json TEXT"),
	},
	{
		version: 4,
		up: (db) => db.exec("ALTER TABLE symbol_graph_generation ADD COLUMN sources_json TEXT"),
	},
	{
		version: 5,
		up: (db) => db.exec("ALTER TABLE symbol_graph_generation ADD COLUMN result_json TEXT"),
	},
	{
		version: 6,
		up: (db) => {
			db.exec("ALTER TABLE symbol_graph_generation ADD COLUMN walked_files_json TEXT");
			db.exec("CREATE INDEX symbol_nodes_path_idx ON symbol_nodes (path)");
		},
	},
];

interface NodeRow {
	name: string;
	kind: string;
	path: string;
	line: number;
	character: number;
}

interface GenerationRow {
	source_fingerprint: string;
	max_files: number;
	max_symbols_per_file: number;
	completed_at: number;
	files_processed: number;
	symbols_processed: number;
	nodes_added: number;
	edges_added: number;
	provenance_json: string | null;
	sources_json: string | null;
	result_json: string | null;
	walked_files_json: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asProvenance(value: unknown): IntelligenceProvenance | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value;
	if (
		(candidate.fidelity !== "semantic" && candidate.fidelity !== "structural") ||
		typeof candidate.backend !== "string" ||
		typeof candidate.languageId !== "string" ||
		(candidate.authority !== "language-server" && candidate.authority !== "parser" && candidate.authority !== "compiler") ||
		(candidate.freshness !== "live-process" && candidate.freshness !== "content-hash" && candidate.freshness !== "filesystem-snapshot") ||
		!Array.isArray(candidate.limitations) ||
		!candidate.limitations.every((item) => typeof item === "string")
	) {
		return undefined;
	}
	return {
		fidelity: candidate.fidelity,
		backend: candidate.backend,
		languageId: candidate.languageId,
		authority: candidate.authority,
		freshness: candidate.freshness,
		limitations: candidate.limitations,
	};
}

function parseJson(json: string | null): unknown {
	if (!json) return undefined;
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}

function parseProvenance(json: string | null): IntelligenceProvenance | undefined {
	return asProvenance(parseJson(json));
}

function parseSources(json: string | null): readonly IntelligenceProvenance[] | undefined {
	const value = parseJson(json);
	if (!Array.isArray(value)) return undefined;
	const sources = value.map(asProvenance);
	return sources.every((source) => source !== undefined) ? sources : undefined;
}

/** Absent for generations persisted before purge-on-regeneration existed; bounded by the same row's own max_files, its true origin. */
function parseWalkedFiles(json: string | null, maxFiles: number): readonly string[] | undefined {
	const value = parseJson(json);
	if (!Array.isArray(value) || value.length > maxFiles || !value.every((item) => typeof item === "string")) return undefined;
	return value;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function asPopulationFailure(value: unknown): SymbolGraphPopulationFailure | undefined {
	if (!isRecord(value)) return undefined;
	const provenance = asProvenance(value.provenance);
	if (
		typeof value.path !== "string" ||
		value.path.length > 4096 ||
		(value.operation !== "document-symbols" && value.operation !== "outgoing-calls") ||
		typeof value.code !== "string" ||
		value.code.length > 100 ||
		typeof value.message !== "string" ||
		value.message.length > 500 ||
		!provenance
	) {
		return undefined;
	}
	return { path: value.path, operation: value.operation, code: value.code, message: value.message, provenance };
}

function parsePopulationResult(json: string | null): PopulateSymbolGraphResult | undefined {
	const value = parseJson(json);
	if (!isRecord(value) || (value.completeness !== "complete" && value.completeness !== "partial") || !Array.isArray(value.failures)) return undefined;
	if (
		!isNonNegativeInteger(value.filesAttempted) ||
		!isNonNegativeInteger(value.filesProcessed) ||
		!isNonNegativeInteger(value.filesFailed) ||
		!isNonNegativeInteger(value.symbolsProcessed) ||
		!isNonNegativeInteger(value.nodesAdded) ||
		!isNonNegativeInteger(value.edgesAdded) ||
		!isNonNegativeInteger(value.failureCount) ||
		typeof value.failuresTruncated !== "boolean" ||
		value.failures.length > 100
	) {
		return undefined;
	}
	const failures = value.failures.map(asPopulationFailure);
	if (
		!failures.every((failure) => failure !== undefined) ||
		value.filesProcessed > value.filesAttempted ||
		value.filesFailed > value.filesAttempted ||
		failures.length > value.failureCount ||
		(value.completeness === "complete") !== (value.failureCount === 0) ||
		value.failuresTruncated !== value.failureCount > failures.length
	) {
		return undefined;
	}
	return {
		completeness: value.completeness,
		filesAttempted: value.filesAttempted,
		filesProcessed: value.filesProcessed,
		filesFailed: value.filesFailed,
		symbolsProcessed: value.symbolsProcessed,
		nodesAdded: value.nodesAdded,
		edgesAdded: value.edgesAdded,
		failureCount: value.failureCount,
		failures,
		failuresTruncated: value.failuresTruncated,
	};
}

/**
 * SQLite-backed SymbolGraphPort; survives a daemon restart pointed at the
 * same database file. reachableFrom uses `WITH RECURSIVE` rather than an
 * application-level loop issuing one query per hop -- one round trip
 * regardless of maxDepth.
 */
export class SqliteSymbolGraph implements SymbolGraphPort {
	private readonly db: Database;

	constructor(path: string) {
		this.db = openSqliteWithPragmas(path, { migrations: MIGRATIONS });
	}

	async addNode(node: SymbolNode): Promise<void> {
		this.db
			.query(
				"INSERT INTO symbol_nodes (id, name, kind, path, line, character) VALUES (?, ?, ?, ?, ?, ?) " +
					"ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, path = excluded.path, line = excluded.line, character = excluded.character",
			)
			.run(node.id, node.name, node.kind, node.location.path, node.location.line, node.location.character);
	}

	async getNode(id: SymbolNodeId): Promise<SymbolNode | undefined> {
		const row = this.db.query("SELECT name, kind, path, line, character FROM symbol_nodes WHERE id = ?").get(id) as NodeRow | null;
		if (!row) return undefined;
		return { id, name: row.name, kind: row.kind, location: { path: row.path, line: row.line, character: row.character } };
	}

	async addEdge(from: SymbolNodeId, to: SymbolNodeId, kind: SymbolEdgeKind): Promise<void> {
		this.db.query("INSERT OR IGNORE INTO symbol_edges (from_id, to_id, kind) VALUES (?, ?, ?)").run(from, to, kind);
	}

	async removeNodesForFile(path: string): Promise<void> {
		this.db
			.query("DELETE FROM symbol_edges WHERE from_id IN (SELECT id FROM symbol_nodes WHERE path = ?) OR to_id IN (SELECT id FROM symbol_nodes WHERE path = ?)")
			.run(path, path);
		this.db.query("DELETE FROM symbol_nodes WHERE path = ?").run(path);
	}

	async edgesFrom(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]> {
		const rows = kind
			? (this.db.query("SELECT to_id FROM symbol_edges WHERE from_id = ? AND kind = ?").all(id, kind) as { to_id: string }[])
			: (this.db.query("SELECT to_id FROM symbol_edges WHERE from_id = ?").all(id) as { to_id: string }[]);
		return rows.map((row) => row.to_id);
	}

	async edgesTo(id: SymbolNodeId, kind?: SymbolEdgeKind): Promise<readonly SymbolNodeId[]> {
		const rows = kind
			? (this.db.query("SELECT from_id FROM symbol_edges WHERE to_id = ? AND kind = ?").all(id, kind) as { from_id: string }[])
			: (this.db.query("SELECT from_id FROM symbol_edges WHERE to_id = ?").all(id) as { from_id: string }[]);
		return rows.map((row) => row.from_id);
	}

	async allNodes(maxNodes: number): Promise<readonly SymbolNode[]> {
		const rows = this.db.query("SELECT id, name, kind, path, line, character FROM symbol_nodes LIMIT ?").all(maxNodes) as (NodeRow & { id: string })[];
		return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, location: { path: row.path, line: row.line, character: row.character } }));
	}

	async allEdges(maxEdges: number): Promise<readonly SymbolEdgeRecord[]> {
		const rows = this.db.query("SELECT from_id, to_id, kind FROM symbol_edges LIMIT ?").all(maxEdges) as {
			from_id: string;
			to_id: string;
			kind: SymbolEdgeKind;
		}[];
		return rows.map((row) => ({ from: row.from_id, to: row.to_id, kind: row.kind }));
	}

	async reachableFrom(id: SymbolNodeId, options: { maxDepth: number; kind?: SymbolEdgeKind }): Promise<readonly SymbolNodeId[]> {
		if (options.maxDepth < 1) return [];
		const kindClause = options.kind ? "AND e.kind = $kind" : "";
		const sql = `
			WITH RECURSIVE reachable(id, depth) AS (
				SELECT to_id, 1 FROM symbol_edges e WHERE e.from_id = $id ${kindClause}
				UNION
				SELECT e.to_id, r.depth + 1
				FROM symbol_edges e
				JOIN reachable r ON e.from_id = r.id
				WHERE r.depth < $maxDepth ${kindClause}
			)
			SELECT DISTINCT id FROM reachable
		`;
		const params: Record<string, string | number> = { $id: id, $maxDepth: options.maxDepth };
		if (options.kind) params.$kind = options.kind;
		const rows = this.db.query(sql).all(params) as { id: string }[];
		return rows.map((row) => row.id).filter((reachedId) => reachedId !== id);
	}

	async getGeneration(): Promise<SymbolGraphGeneration | undefined> {
		const row = this.db
			.query(
				"SELECT source_fingerprint, max_files, max_symbols_per_file, completed_at, files_processed, symbols_processed, nodes_added, edges_added, provenance_json, sources_json, result_json, walked_files_json FROM symbol_graph_generation WHERE singleton = 1",
			)
			.get() as GenerationRow | null;
		if (!row) return undefined;
		const provenance = parseProvenance(row.provenance_json);
		const sources = parseSources(row.sources_json);
		const walkedFiles = parseWalkedFiles(row.walked_files_json, row.max_files);
		const result =
			parsePopulationResult(row.result_json) ??
			({
				completeness: "complete",
				filesAttempted: row.files_processed,
				filesProcessed: row.files_processed,
				filesFailed: 0,
				symbolsProcessed: row.symbols_processed,
				nodesAdded: row.nodes_added,
				edgesAdded: row.edges_added,
				failureCount: 0,
				failures: [],
				failuresTruncated: false,
			} satisfies PopulateSymbolGraphResult);
		return {
			sourceFingerprint: row.source_fingerprint,
			maxFiles: row.max_files,
			maxSymbolsPerFile: row.max_symbols_per_file,
			completedAt: row.completed_at,
			...(provenance ? { provenance } : {}),
			...(sources ? { sources } : {}),
			...(walkedFiles ? { walkedFiles } : {}),
			result,
		};
	}

	async setGeneration(generation: SymbolGraphGeneration): Promise<void> {
		this.db
			.query(
				"INSERT INTO symbol_graph_generation (singleton, source_fingerprint, max_files, max_symbols_per_file, completed_at, files_processed, symbols_processed, nodes_added, edges_added, provenance_json, sources_json, result_json, walked_files_json) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET source_fingerprint = excluded.source_fingerprint, max_files = excluded.max_files, max_symbols_per_file = excluded.max_symbols_per_file, completed_at = excluded.completed_at, files_processed = excluded.files_processed, symbols_processed = excluded.symbols_processed, nodes_added = excluded.nodes_added, edges_added = excluded.edges_added, provenance_json = excluded.provenance_json, sources_json = excluded.sources_json, result_json = excluded.result_json, walked_files_json = excluded.walked_files_json",
			)
			.run(
				generation.sourceFingerprint,
				generation.maxFiles,
				generation.maxSymbolsPerFile,
				generation.completedAt,
				generation.result.filesProcessed,
				generation.result.symbolsProcessed,
				generation.result.nodesAdded,
				generation.result.edgesAdded,
				generation.provenance ? JSON.stringify(generation.provenance) : null,
				generation.sources ? JSON.stringify(generation.sources) : null,
				JSON.stringify(generation.result),
				generation.walkedFiles ? JSON.stringify(generation.walkedFiles) : null,
			);
	}

	async close(): Promise<void> {
		this.db.close();
	}
}
