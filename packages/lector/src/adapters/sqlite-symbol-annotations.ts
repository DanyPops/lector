import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type Migration, openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
import type { ContentHash } from "../domain/content-hash.ts";
import type { AnnotationId, AnnotationStatus, CreateSymbolAnnotationInput, SymbolAnnotation, SymbolAnnotationAnchor } from "../domain/symbol-annotation.ts";
import type { SymbolAnnotationListOptions, SymbolAnnotationPort } from "../ports/symbol-annotation-port.ts";

const DEFAULT_MAX_RESULTS = 200;

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		up: (db) => {
			db.exec(
				"CREATE TABLE symbol_annotations (id TEXT PRIMARY KEY, subtype TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
			);
			db.exec("CREATE INDEX symbol_annotations_status_idx ON symbol_annotations (status)");
			db.exec("CREATE INDEX symbol_annotations_subtype_idx ON symbol_annotations (subtype)");
			db.exec(
				"CREATE TABLE symbol_annotation_anchors (annotation_id TEXT NOT NULL REFERENCES symbol_annotations(id) ON DELETE CASCADE, symbol_node_id TEXT NOT NULL, path TEXT NOT NULL, file_content_hash TEXT NOT NULL, PRIMARY KEY (annotation_id, symbol_node_id))",
			);
		},
	},
];

interface AnnotationRow {
	id: string;
	subtype: string;
	title: string;
	body: string;
	status: AnnotationStatus;
	created_at: number;
	updated_at: number;
}

interface AnchorRow {
	symbol_node_id: string;
	path: string;
	file_content_hash: string;
}

/** SQLite-backed SymbolAnnotationPort (via daemon-kit's migration-runner bootstrap, same pattern as SqliteSymbolGraph/SqliteContentCache) -- durable across daemon restarts. */
export class SqliteSymbolAnnotations implements SymbolAnnotationPort {
	private readonly db: Database;

	constructor(path: string) {
		this.db = openSqliteWithPragmas(path, { migrations: MIGRATIONS });
	}

	private anchorsFor(id: AnnotationId): readonly SymbolAnnotationAnchor[] {
		const rows = this.db.query("SELECT symbol_node_id, path, file_content_hash FROM symbol_annotation_anchors WHERE annotation_id = ?").all(id) as AnchorRow[];
		return rows.map((row) => ({ symbolNodeId: row.symbol_node_id, path: row.path, fileContentHash: row.file_content_hash as ContentHash }));
	}

	private toAnnotation(row: AnnotationRow): SymbolAnnotation {
		return {
			id: row.id,
			subtype: row.subtype,
			title: row.title,
			body: row.body,
			status: row.status,
			anchors: this.anchorsFor(row.id),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private insertAnchors(annotationId: AnnotationId, anchors: readonly SymbolAnnotationAnchor[]): void {
		const insert = this.db.query("INSERT INTO symbol_annotation_anchors (annotation_id, symbol_node_id, path, file_content_hash) VALUES (?, ?, ?, ?)");
		for (const anchor of anchors) insert.run(annotationId, anchor.symbolNodeId, anchor.path, anchor.fileContentHash);
	}

	async create(input: CreateSymbolAnnotationInput): Promise<SymbolAnnotation> {
		const id = randomUUID();
		const now = Date.now();
		this.db.transaction(() => {
			this.db
				.query("INSERT INTO symbol_annotations (id, subtype, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'fresh', ?, ?)")
				.run(id, input.subtype, input.title, input.body, now, now);
			this.insertAnchors(id, input.anchors);
		})();
		return { id, subtype: input.subtype, title: input.title, body: input.body, status: "fresh", anchors: input.anchors, createdAt: now, updatedAt: now };
	}

	async get(id: AnnotationId): Promise<SymbolAnnotation | undefined> {
		const row = this.db
			.query("SELECT id, subtype, title, body, status, created_at, updated_at FROM symbol_annotations WHERE id = ?")
			.get(id) as AnnotationRow | null;
		return row ? this.toAnnotation(row) : undefined;
	}

	async list(options: SymbolAnnotationListOptions = {}): Promise<readonly SymbolAnnotation[]> {
		const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (options.subtype !== undefined) {
			clauses.push("subtype = ?");
			params.push(options.subtype);
		}
		if (options.status !== undefined) {
			clauses.push("status = ?");
			params.push(options.status);
		} else {
			clauses.push("status != 'scrubbed'");
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.query(`SELECT id, subtype, title, body, status, created_at, updated_at FROM symbol_annotations ${where} ORDER BY created_at ASC LIMIT ?`)
			.all(...params, maxResults) as AnnotationRow[];
		return rows.map((row) => this.toAnnotation(row));
	}

	async setStatus(id: AnnotationId, status: "fresh" | "stale"): Promise<SymbolAnnotation | undefined> {
		const now = Date.now();
		this.db.query("UPDATE symbol_annotations SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
		return this.get(id);
	}

	async refresh(id: AnnotationId, input: CreateSymbolAnnotationInput): Promise<SymbolAnnotation | undefined> {
		const existing = await this.get(id);
		if (!existing) return undefined;
		const now = Date.now();
		this.db.transaction(() => {
			this.db
				.query("UPDATE symbol_annotations SET subtype = ?, title = ?, body = ?, status = 'fresh', updated_at = ? WHERE id = ?")
				.run(input.subtype, input.title, input.body, now, id);
			this.db.query("DELETE FROM symbol_annotation_anchors WHERE annotation_id = ?").run(id);
			this.insertAnchors(id, input.anchors);
		})();
		return this.get(id);
	}

	async scrub(id: AnnotationId): Promise<boolean> {
		const existing = await this.get(id);
		if (!existing || existing.status === "scrubbed") return false;
		this.db.query("UPDATE symbol_annotations SET status = 'scrubbed', updated_at = ? WHERE id = ?").run(Date.now(), id);
		return true;
	}

	async restore(id: AnnotationId): Promise<boolean> {
		const existing = await this.get(id);
		if (existing?.status !== "scrubbed") return false;
		this.db.query("UPDATE symbol_annotations SET status = 'stale', updated_at = ? WHERE id = ?").run(Date.now(), id);
		return true;
	}

	async close(): Promise<void> {
		this.db.close();
	}
}
