import type { OperationInputs, OperationOutputs } from "@danypops/lector";
import { withWorkspace, workspaceForAnnotationPath } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

/** Match ANNOTATION_READ_PERMISSIONS/ANNOTATION_WRITE_PERMISSIONS' own declared values server-side (symbol-annotation/operation-registration.ts). */
const ANNOTATION_READ_PERMISSIONS = ["workspace:read"];
const ANNOTATION_WRITE_PERMISSIONS = ["workspace:write"];

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
		call: LectorVehicleCall,
	): Promise<OperationOutputs["workspace.createAnnotation"]>;
	get(path: string, id: string, call: LectorVehicleCall): Promise<OperationOutputs["workspace.getAnnotation"]>;
	list(
		path: string,
		options: { subtype?: string; status?: OperationInputs["workspace.listAnnotations"]["status"]; maxResults?: number; query?: string },
		call: LectorVehicleCall,
	): Promise<OperationOutputs["workspace.listAnnotations"]>;
	refresh(
		path: string,
		id: string,
		subtype: string,
		title: string,
		body: string,
		anchors: readonly AnnotationAnchorInput[],
		call: LectorVehicleCall,
	): Promise<OperationOutputs["workspace.refreshAnnotation"]>;
	scrub(path: string, id: string, call: LectorVehicleCall): Promise<OperationOutputs["workspace.scrubAnnotation"]>;
	restore(path: string, id: string, call: LectorVehicleCall): Promise<OperationOutputs["workspace.restoreAnnotation"]>;
	contain(path: string, parentId: string, childId: string, call: LectorVehicleCall): Promise<OperationOutputs["workspace.containAnnotation"]>;
	uncontain(path: string, parentId: string, childId: string, call: LectorVehicleCall): Promise<OperationOutputs["workspace.uncontainAnnotation"]>;
	tree(path: string, rootId: string, maxDepth: number, call: LectorVehicleCall): Promise<OperationOutputs["workspace.annotationTree"]>;
}

export function createLectorSymbolAnnotationOperations(): SymbolAnnotationOperations {
	return {
		async create(path, subtype, title, body, anchors, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation(
						"workspace.createAnnotation",
						{ workspaceId, subtype, title, body, anchors },
						ANNOTATION_WRITE_PERMISSIONS,
						call,
					);
					return result.details.output as OperationOutputs["workspace.createAnnotation"];
				},
			);
		},
		async get(path, id, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation("workspace.getAnnotation", { workspaceId, id }, ANNOTATION_READ_PERMISSIONS, call);
					return result.details.output as OperationOutputs["workspace.getAnnotation"];
				},
			);
		},
		async list(path, options, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation(
						"workspace.listAnnotations",
						{ workspaceId, subtype: options.subtype, status: options.status, maxResults: options.maxResults, query: options.query },
						ANNOTATION_READ_PERMISSIONS,
						call,
					);
					return result.details.output as OperationOutputs["workspace.listAnnotations"];
				},
			);
		},
		async refresh(path, id, subtype, title, body, anchors, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation(
						"workspace.refreshAnnotation",
						{ workspaceId, id, subtype, title, body, anchors },
						ANNOTATION_WRITE_PERMISSIONS,
						call,
					);
					return result.details.output as OperationOutputs["workspace.refreshAnnotation"];
				},
			);
		},
		async scrub(path, id, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation("workspace.scrubAnnotation", { workspaceId, id }, ANNOTATION_WRITE_PERMISSIONS, call);
					return result.details.output as OperationOutputs["workspace.scrubAnnotation"];
				},
			);
		},
		async restore(path, id, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation("workspace.restoreAnnotation", { workspaceId, id }, ANNOTATION_WRITE_PERMISSIONS, call);
					return result.details.output as OperationOutputs["workspace.restoreAnnotation"];
				},
			);
		},
		async contain(path, parentId, childId, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation(
						"workspace.containAnnotation",
						{ workspaceId, parentId, childId },
						ANNOTATION_WRITE_PERMISSIONS,
						call,
					);
					return result.details.output as OperationOutputs["workspace.containAnnotation"];
				},
			);
		},
		async uncontain(path, parentId, childId, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation(
						"workspace.uncontainAnnotation",
						{ workspaceId, parentId, childId },
						ANNOTATION_WRITE_PERMISSIONS,
						call,
					);
					return result.details.output as OperationOutputs["workspace.uncontainAnnotation"];
				},
			);
		},
		async tree(path, rootId, maxDepth, call) {
			return withWorkspace(
				() => workspaceForAnnotationPath(path),
				async ({ workspaceId }) => {
					const result = await invokeLectorVehicleOperation("workspace.annotationTree", { workspaceId, rootId, maxDepth }, ANNOTATION_READ_PERMISSIONS, call);
					return result.details.output as OperationOutputs["workspace.annotationTree"];
				},
			);
		},
	};
}
