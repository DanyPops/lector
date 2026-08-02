import type { SymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import type { ContentHash } from "./content-hash.ts";

export type AnnotationId = string;

/** "fresh"/"stale" are computed by staleness detection; "scrubbed" is set only by an explicit scrub, never inferred. */
export type AnnotationStatus = "fresh" | "stale" | "scrubbed";

/**
 * One symbol this annotation's narrative depends on. `fileContentHash` is
 * the anchor's file's ContentHash as of the last attach/refresh -- the
 * baseline staleness detection compares the current hash against. `path`
 * is carried alongside `symbolNodeId` rather than parsed back out of it:
 * SymbolNodeId is an opaque identity elsewhere in the domain, and this
 * anchor needs the path to re-read the file's current content.
 */
export interface SymbolAnnotationAnchor {
	readonly symbolNodeId: SymbolNodeId;
	readonly path: string;
	readonly fileContentHash: ContentHash;
}

/**
 * Agent-authored narrative content anchored to one or more graph symbols --
 * e.g. a "user story dataflow" spanning every symbol touched end-to-end,
 * explaining the data mutations across them. Lector detects when an anchor
 * no longer matches reality (§ symbol-annotation-staleness.ts); it never
 * rewrites the narrative itself -- a stale annotation is either refreshed
 * (re-authored and re-anchored) or scrubbed by an explicit caller decision.
 */
export interface SymbolAnnotation {
	readonly id: AnnotationId;
	/** Free-form, agent-chosen (e.g. "user-story-dataflow", "comment") -- not a hardcoded enum. */
	readonly subtype: string;
	readonly title: string;
	readonly body: string;
	readonly status: AnnotationStatus;
	readonly anchors: readonly SymbolAnnotationAnchor[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface CreateSymbolAnnotationInput {
	readonly subtype: string;
	readonly title: string;
	readonly body: string;
	readonly anchors: readonly SymbolAnnotationAnchor[];
}
