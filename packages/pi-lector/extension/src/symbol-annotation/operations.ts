import type { OperationInputs, OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForAnnotationPath } from "../lector-client.ts";

/** A bare symbol position an anchor is given as -- symbolNodeId and the anchor's baseline file hash are derived server-side, never supplied by the caller. */
export interface AnnotationAnchorInput {
	readonly path: string;
	readonly line: number;
	readonly character: number;
}

/**
 * Thin wrappers over Lector's annotation operations. Every operation resolves its workspace from
 * its own `path` parameter via workspaceForAnnotationPath -- a real project directory or an
 * existing source file, never dirname()'d unconditionally the way a plain code-intelligence
 * path is. `path` here means "which workspace this call belongs to," not necessarily one of the
 * operation's own anchors (create/refresh's anchors carry their own, separately-validated paths
 * server-side).
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
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.createAnnotation", { workspaceId, subtype, title, body, anchors });
				},
			);
		},
		async get(path, id) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.getAnnotation", { workspaceId, id });
				},
			);
		},
		async list(path, options = {}) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
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
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.refreshAnnotation", { workspaceId, id, subtype, title, body, anchors });
				},
			);
		},
		async scrub(path, id) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.scrubAnnotation", { workspaceId, id });
				},
			);
		},
		async restore(path, id) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.restoreAnnotation", { workspaceId, id });
				},
			);
		},
		async contain(path, parentId, childId) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.containAnnotation", { workspaceId, parentId, childId });
				},
			);
		},
		async uncontain(path, parentId, childId) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.callOnce("workspace.uncontainAnnotation", { workspaceId, parentId, childId });
				},
			);
		},
		async tree(path, rootId, maxDepth) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.annotationTree", { workspaceId, rootId, maxDepth });
				},
			);
		},
	};
}
