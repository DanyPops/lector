import type { AnnotationId, AnnotationStatus, CreateSymbolAnnotationInput, SymbolAnnotation } from "../domain/symbol-annotation.ts";

export interface SymbolAnnotationListOptions {
	readonly subtype?: string;
	/** Defaults to excluding "scrubbed" -- pass it explicitly to include scrubbed annotations (e.g. a trash-listing view). */
	readonly status?: AnnotationStatus;
	readonly maxResults?: number;
	/** Case-insensitive substring match against title or body -- the near-term "good enough" free-text search over agent-authored annotations. */
	readonly query?: string;
}

/**
 * SymbolAnnotationPort -- persists agent-authored narrative content anchored
 * to one or more SymbolGraphPort nodes. This port is a pure store: it never
 * computes staleness itself (see domain/check-annotation-staleness.ts for
 * that), only records the status a caller determined and persists/serves
 * annotations and their anchors. Containment (contains/contained-by) is the
 * same philosophy applied to the edge between two annotations: this port
 * only stores and reports the edge -- existence validation and cycle
 * safety are a caller's business rule (see domain/annotation-containment.ts
 * and service.ts's containAnnotationHandler), never enforced here.
 */
export interface SymbolAnnotationPort {
	create(input: CreateSymbolAnnotationInput): Promise<SymbolAnnotation>;
	get(id: AnnotationId): Promise<SymbolAnnotation | undefined>;
	/** Bounded by maxResults (a required-in-spirit default is enforced by each adapter). */
	list(options?: SymbolAnnotationListOptions): Promise<readonly SymbolAnnotation[]>;
	/** Persists a fresh/stale transition computed by the caller. Never moves to/from "scrubbed" -- use scrub/restore for that. */
	setStatus(id: AnnotationId, status: "fresh" | "stale"): Promise<SymbolAnnotation | undefined>;
	/** Replaces body/anchors and resets status to "fresh" -- a refresh is a new write, not a partial patch. */
	refresh(id: AnnotationId, input: CreateSymbolAnnotationInput): Promise<SymbolAnnotation | undefined>;
	/** Soft-delete: excluded from list() by default, still reachable via get(), restorable. Matches Papyrus's own trash pattern. */
	scrub(id: AnnotationId): Promise<boolean>;
	/** Restores a scrubbed annotation to "stale" (never "fresh") -- a restore does not re-validate freshness on its own. */
	restore(id: AnnotationId): Promise<boolean>;
	/** Idempotent: adding an already-present edge is a no-op. Returns true if the edge was newly created, false if it already existed. Never validates that either id exists or that it wouldn't create a cycle -- a caller's business rule. */
	addContainmentEdge(parentId: AnnotationId, childId: AnnotationId): Promise<boolean>;
	/** Idempotent: removing an already-absent edge is a no-op. Returns true if an edge was actually removed, false if it was already absent. */
	removeContainmentEdge(parentId: AnnotationId, childId: AnnotationId): Promise<boolean>;
	/** Direct children only, one hop, insertion order -- never a recursive tree (see domain/annotation-containment.ts's annotationsContainedFrom for that). */
	children(parentId: AnnotationId): Promise<readonly AnnotationId[]>;
	/** Direct parents only, one hop -- every container currently holding this annotation. */
	parents(childId: AnnotationId): Promise<readonly AnnotationId[]>;
	close(): Promise<void>;
}
