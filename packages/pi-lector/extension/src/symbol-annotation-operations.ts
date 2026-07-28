import type { OperationInputs, OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForCodeIntelligencePath } from "./lector-client.ts";

/** A bare symbol position an anchor is given as -- symbolNodeId and the anchor's baseline file hash are derived server-side, never supplied by the caller. */
export interface AnnotationAnchorInput {
	readonly path: string;
	readonly line: number;
	readonly character: number;
}

/**
 * Thin wrappers over Lector's annotation operations. Anchored to a workspace
 * via the first anchor's own path (workspaceForCodeIntelligencePath) --
 * every operation that needs a workspace already has at least one real
 * anchor position or an id whose workspace the caller already knows.
 */
export interface SymbolAnnotationOperations {
	create(
		path: string,
		subtype: string,
		title: string,
		body: string,
		anchors: readonly AnnotationAnchorInput[],
	): Promise<OperationOutputs["workspace.createAnnotation"]>;
	get(path: string, id: string): Promise<OperationOutputs["workspace.getAnnotation"]>;
	list(
		path: string,
		options?: { subtype?: string; status?: OperationInputs["workspace.listAnnotations"]["status"]; maxResults?: number; query?: string },
	): Promise<OperationOutputs["workspace.listAnnotations"]>;
	refresh(
		path: string,
		id: string,
		subtype: string,
		title: string,
		body: string,
		anchors: readonly AnnotationAnchorInput[],
	): Promise<OperationOutputs["workspace.refreshAnnotation"]>;
	scrub(path: string, id: string): Promise<OperationOutputs["workspace.scrubAnnotation"]>;
	restore(path: string, id: string): Promise<OperationOutputs["workspace.restoreAnnotation"]>;
	contain(path: string, parentId: string, childId: string): Promise<OperationOutputs["workspace.containAnnotation"]>;
	uncontain(path: string, parentId: string, childId: string): Promise<OperationOutputs["workspace.uncontainAnnotation"]>;
	tree(path: string, rootId: string, maxDepth: number): Promise<OperationOutputs["workspace.annotationTree"]>;
}

export function createLectorSymbolAnnotationOperations(): SymbolAnnotationOperations {
	return {
		async create(path, subtype, title, body, anchors) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.createAnnotation", { workspaceId, subtype, title, body, anchors });
				},
			);
		},
		async get(path, id) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.getAnnotation", { workspaceId, id });
				},
			);
		},
		async list(path, options = {}) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.listAnnotations", {
						workspaceId,
						subtype: options.subtype,
						status: options.status,
						maxResults: options.maxResults,
						query: options.query,
					});
				},
			);
		},
		async refresh(path, id, subtype, title, body, anchors) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.refreshAnnotation", { workspaceId, id, subtype, title, body, anchors });
				},
			);
		},
		async scrub(path, id) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.scrubAnnotation", { workspaceId, id });
				},
			);
		},
		async restore(path, id) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.restoreAnnotation", { workspaceId, id });
				},
			);
		},
		async contain(path, parentId, childId) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.containAnnotation", { workspaceId, parentId, childId });
				},
			);
		},
		async uncontain(path, parentId, childId) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.uncontainAnnotation", { workspaceId, parentId, childId });
				},
			);
		},
		async tree(path, rootId, maxDepth) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.annotationTree", { workspaceId, rootId, maxDepth });
				},
			);
		},
	};
}
