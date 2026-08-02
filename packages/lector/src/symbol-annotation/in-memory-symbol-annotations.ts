import { randomUUID } from "node:crypto";
import type { SymbolAnnotationListOptions, SymbolAnnotationPort } from "./port.ts";
import type { AnnotationId, CreateSymbolAnnotationInput, SymbolAnnotation } from "./symbol-annotation.ts";

const DEFAULT_MAX_RESULTS = 200;

/** In-memory SymbolAnnotationPort for tests and small/ephemeral workspaces. */
export class InMemorySymbolAnnotations implements SymbolAnnotationPort {
	private readonly annotations = new Map<AnnotationId, SymbolAnnotation>();
	/** parentId -> ordered list of childIds, insertion order preserved. */
	private readonly childrenOf = new Map<AnnotationId, AnnotationId[]>();
	/** childId -> set of parentIds -- kept in sync with childrenOf on every mutation, not derived on read. */
	private readonly parentsOf = new Map<AnnotationId, Set<AnnotationId>>();

	async create(input: CreateSymbolAnnotationInput): Promise<SymbolAnnotation> {
		const now = Date.now();
		const annotation: SymbolAnnotation = {
			id: randomUUID(),
			subtype: input.subtype,
			title: input.title,
			body: input.body,
			status: "fresh",
			anchors: input.anchors,
			createdAt: now,
			updatedAt: now,
		};
		this.annotations.set(annotation.id, annotation);
		return annotation;
	}

	async get(id: AnnotationId): Promise<SymbolAnnotation | undefined> {
		return this.annotations.get(id);
	}

	async list(options: SymbolAnnotationListOptions = {}): Promise<readonly SymbolAnnotation[]> {
		const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
		const wantedStatus = options.status ?? undefined;
		const query = options.query?.toLowerCase();
		const results: SymbolAnnotation[] = [];
		for (const annotation of this.annotations.values()) {
			if (options.subtype !== undefined && annotation.subtype !== options.subtype) continue;
			if (wantedStatus !== undefined) {
				if (annotation.status !== wantedStatus) continue;
			} else if (annotation.status === "scrubbed") {
				continue;
			}
			if (query !== undefined && !annotation.title.toLowerCase().includes(query) && !annotation.body.toLowerCase().includes(query)) continue;
			results.push(annotation);
			if (results.length >= maxResults) break;
		}
		return results;
	}

	async setStatus(id: AnnotationId, status: "fresh" | "stale"): Promise<SymbolAnnotation | undefined> {
		const existing = this.annotations.get(id);
		if (!existing) return undefined;
		const updated: SymbolAnnotation = { ...existing, status, updatedAt: Date.now() };
		this.annotations.set(id, updated);
		return updated;
	}

	async refresh(id: AnnotationId, input: CreateSymbolAnnotationInput): Promise<SymbolAnnotation | undefined> {
		const existing = this.annotations.get(id);
		if (!existing) return undefined;
		const updated: SymbolAnnotation = {
			...existing,
			subtype: input.subtype,
			title: input.title,
			body: input.body,
			anchors: input.anchors,
			status: "fresh",
			updatedAt: Date.now(),
		};
		this.annotations.set(id, updated);
		return updated;
	}

	async scrub(id: AnnotationId): Promise<boolean> {
		const existing = this.annotations.get(id);
		if (!existing || existing.status === "scrubbed") return false;
		this.annotations.set(id, { ...existing, status: "scrubbed", updatedAt: Date.now() });
		return true;
	}

	async restore(id: AnnotationId): Promise<boolean> {
		const existing = this.annotations.get(id);
		if (existing?.status !== "scrubbed") return false;
		this.annotations.set(id, { ...existing, status: "stale", updatedAt: Date.now() });
		return true;
	}

	async addContainmentEdge(parentId: AnnotationId, childId: AnnotationId): Promise<boolean> {
		const existingChildren = this.childrenOf.get(parentId) ?? [];
		if (existingChildren.includes(childId)) return false;
		existingChildren.push(childId);
		this.childrenOf.set(parentId, existingChildren);
		const parentSet = this.parentsOf.get(childId) ?? new Set<AnnotationId>();
		parentSet.add(parentId);
		this.parentsOf.set(childId, parentSet);
		return true;
	}

	async removeContainmentEdge(parentId: AnnotationId, childId: AnnotationId): Promise<boolean> {
		const existingChildren = this.childrenOf.get(parentId);
		const index = existingChildren?.indexOf(childId) ?? -1;
		if (index === -1) return false;
		existingChildren?.splice(index, 1);
		this.parentsOf.get(childId)?.delete(parentId);
		return true;
	}

	async children(parentId: AnnotationId): Promise<readonly AnnotationId[]> {
		return [...(this.childrenOf.get(parentId) ?? [])];
	}

	async parents(childId: AnnotationId): Promise<readonly AnnotationId[]> {
		return [...(this.parentsOf.get(childId) ?? [])];
	}

	async close(): Promise<void> {
		this.annotations.clear();
		this.childrenOf.clear();
		this.parentsOf.clear();
	}
}
