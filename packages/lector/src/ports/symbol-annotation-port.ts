import type { AnnotationId, AnnotationStatus, CreateSymbolAnnotationInput, SymbolAnnotation } from "../domain/symbol-annotation.ts";

export interface SymbolAnnotationListOptions {
	readonly subtype?: string;
	/** Defaults to excluding "scrubbed" -- pass it explicitly to include scrubbed annotations (e.g. a trash-listing view). */
	readonly status?: AnnotationStatus;
	readonly maxResults?: number;
}

/**
 * SymbolAnnotationPort -- persists agent-authored narrative content anchored
 * to one or more SymbolGraphPort nodes. This port is a pure store: it never
 * computes staleness itself (see domain/check-annotation-staleness.ts for
 * that), only records the status a caller determined and persists/serves
 * annotations and their anchors.
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
	close(): Promise<void>;
}
