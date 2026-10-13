import {
	bindVehicleOperation,
	defineErrorMapping,
	defineVehicleOperation,
	defineVehicleSchema,
	isNonEmptyString,
	isPositiveSafeInteger,
	notAnObjectIssue,
	passthroughVehicleSchema,
	schemaIssue,
	type VehicleSchemaCodec,
} from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { WORKSPACE_READ_PERMISSION, WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import { StaleExpectedHash } from "../workspace/exact-edit.ts";
import { PathEscapesWorkspaceRoot } from "../workspace/local-filesystem-workspace.ts";
import { FormatterUnavailable, MutationPlanLimitExceeded, MutationRollbackIncomplete } from "../workspace/mutation-plan.ts";
import { ReferenceBasedRenameRequiresFreshGraph, RenameNotSupported } from "./errors.ts";
import type { OperationInputs } from "./operations.ts";
import { type RenamePreviewHandlers, RenamePreviewUnavailable } from "./rename-preview-handlers.ts";
import type { MutableRegistry } from "./workspace-registry.ts";

const string = { type: "string", minLength: 1 } as const;
const number = { type: "integer", minimum: 1 } as const;
const format = { type: "boolean" } as const;
const fields = { workspaceId: string, maxFiles: number, maxEdits: number, maxBytes: number, format };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validBounds(value: Record<string, unknown>): boolean {
	return (
		isPositiveSafeInteger(value.maxFiles) &&
		value.maxFiles <= 5000 &&
		isPositiveSafeInteger(value.maxEdits) &&
		value.maxEdits <= 10000 &&
		isPositiveSafeInteger(value.maxBytes) &&
		value.maxBytes <= 1_048_576 &&
		(value.format === undefined || typeof value.format === "boolean")
	);
}

const rename: VehicleSchemaCodec<OperationInputs["workspace.previewRename"]> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { ...fields, path: string, line: number, character: number, newName: string },
		required: ["workspaceId", "path", "line", "character", "newName", "maxFiles", "maxEdits", "maxBytes"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!record(value)) return notAnObjectIssue();
		if (
			!validBounds(value) ||
			!isNonEmptyString(value.workspaceId) ||
			!isNonEmptyString(value.path) ||
			!isNonEmptyString(value.newName) ||
			!isPositiveSafeInteger(value.line) ||
			!isPositiveSafeInteger(value.character)
		)
			return schemaIssue([], "Invalid rename preview inputs or bounds");
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				path: value.path,
				line: value.line,
				character: value.character,
				newName: value.newName,
				maxFiles: Number(value.maxFiles),
				maxEdits: Number(value.maxEdits),
				maxBytes: Number(value.maxBytes),
				...(typeof value.format === "boolean" ? { format: value.format } : {}),
			},
		};
	},
});
const move: VehicleSchemaCodec<OperationInputs["workspace.previewFileMove"]> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { ...fields, fromPath: string, toPath: string, maxSymbolsPerFile: number, maxAffectedFiles: number },
		required: ["workspaceId", "fromPath", "toPath", "maxFiles", "maxSymbolsPerFile", "maxAffectedFiles", "maxEdits", "maxBytes"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!record(value)) return notAnObjectIssue();
		if (
			!validBounds(value) ||
			!isNonEmptyString(value.workspaceId) ||
			!isNonEmptyString(value.fromPath) ||
			!isNonEmptyString(value.toPath) ||
			!isPositiveSafeInteger(value.maxSymbolsPerFile) ||
			value.maxSymbolsPerFile > 1000 ||
			!isPositiveSafeInteger(value.maxAffectedFiles) ||
			value.maxAffectedFiles > 500
		)
			return schemaIssue([], "Invalid file move preview inputs or bounds");
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				fromPath: value.fromPath,
				toPath: value.toPath,
				maxFiles: Number(value.maxFiles),
				maxEdits: Number(value.maxEdits),
				maxBytes: Number(value.maxBytes),
				maxSymbolsPerFile: value.maxSymbolsPerFile,
				maxAffectedFiles: value.maxAffectedFiles,
				...(typeof value.format === "boolean" ? { format: value.format } : {}),
			},
		};
	},
});
const apply: VehicleSchemaCodec<OperationInputs["workspace.applyRenamePreview"]> = defineVehicleSchema({
	jsonSchema: { type: "object", properties: { workspaceId: string, previewId: string }, required: ["workspaceId", "previewId"], additionalProperties: false },
	safeParse(value) {
		if (!record(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId) || !isNonEmptyString(value.previewId)) return schemaIssue([], "workspaceId and previewId are required");
		return { success: true, value: { workspaceId: value.workspaceId, previewId: value.previewId } };
	},
});

export const RENAME_PREVIEW_PERMISSIONS = [WORKSPACE_READ_PERMISSION];
export const RENAME_APPLY_PERMISSIONS = [WORKSPACE_WRITE_PERMISSION];

const mapError = defineErrorMapping([
	{ errorClass: MutationRollbackIncomplete, category: "internal", code: "mutation-rollback-incomplete" },
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: StaleExpectedHash, category: "conflict", code: "stale-expected-hash" },
	{ errorClass: RenamePreviewUnavailable, category: "not_found", code: "rename-preview-unavailable" },
	{ errorClass: MutationPlanLimitExceeded, category: "validation", code: "mutation-plan-limit" },
	{ errorClass: FormatterUnavailable, category: "validation", code: "formatter-unavailable" },
	{ errorClass: PathEscapesWorkspaceRoot, category: "validation", code: "workspace-edit-outside-root" },
	{ errorClass: ReferenceBasedRenameRequiresFreshGraph, category: "conflict", code: "rename-requires-fresh-graph" },
	{ errorClass: RenameNotSupported, category: "validation", code: "rename-not-supported" },
]);

export function registerRenamePreviewOperations(registry: VehicleRegistry, workspaceRegistry: MutableRegistry, handlers: RenamePreviewHandlers): void {
	const limits = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576 };
	const errors = [
		{ code: "mutation-rollback-incomplete", description: "application failed and some paths could not be rolled back" },
		{ code: "unknown-workspace", description: "the requested workspace is not registered" },
		{ code: "stale-expected-hash", description: "a previewed path changed" },
		{ code: "rename-preview-unavailable", description: "the preview is unknown, expired, consumed or belongs to another workspace" },
		{ code: "mutation-plan-limit", description: "the complete plan exceeds its declared bounds" },
		{ code: "formatter-unavailable", description: "explicit formatting has no configured content formatter" },
		{ code: "workspace-edit-outside-root", description: "a planned path escapes the workspace" },
		{ code: "rename-requires-fresh-graph", description: "file-move coverage is not complete and current at the declared bounds" },
		{ code: "rename-not-supported", description: "the language server does not support semantic rename" },
	];
	const previewRename = defineVehicleOperation({
		name: "workspace.previewRename",
		errors,
		version: 1,
		description: "Computes a complete bounded symbol rename without writing, storing exact final file contents and hashes for approval.",
		input: rename,
		output: passthroughVehicleSchema,
		permissions: RENAME_PREVIEW_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits,
	});
	const previewMove = defineVehicleOperation({
		name: "workspace.previewFileMove",
		errors,
		version: 1,
		description: "Computes a reference-aware file move at explicit fresh graph bounds without writing.",
		input: move,
		output: passthroughVehicleSchema,
		permissions: RENAME_PREVIEW_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits,
	});
	const applyRename = defineVehicleOperation({
		name: "workspace.applyRenamePreview",
		errors,
		version: 1,
		description: "Commits exactly one stored rename plan without recomputation using its original hash/version guards.",
		input: apply,
		output: passthroughVehicleSchema,
		permissions: RENAME_APPLY_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits,
	});
	registry.register(
		"lector-rename-preview",
		bindVehicleOperation(previewRename, () => (context) => mapError(() => handlers.handlers["workspace.previewRename"](workspaceRegistry, context.input))),
	);
	registry.register(
		"lector-rename-preview",
		bindVehicleOperation(previewMove, () => (context) => mapError(() => handlers.handlers["workspace.previewFileMove"](workspaceRegistry, context.input))),
	);
	registry.register(
		"lector-rename-preview",
		bindVehicleOperation(applyRename, () => (context) => mapError(() => handlers.handlers["workspace.applyRenamePreview"](workspaceRegistry, context.input))),
	);
}
