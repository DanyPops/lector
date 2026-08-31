import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { WORKSPACE_READ_PERMISSION, WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import {
	CodeActionCommandDenied,
	type CodeActionHandlers,
	CodeActionPreviewUnavailable,
	DisabledCodeAction,
	InvalidCodeActionRequest,
	StaleCodeActionDocumentVersion,
} from "../service/code-action-handler.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import { OverlappingWorkspaceEdits } from "../workspace/apply-workspace-edit.ts";
import { StaleExpectedHash } from "../workspace/exact-edit.ts";
import { PathEscapesWorkspaceRoot } from "../workspace/local-filesystem-workspace.ts";
import { UnsupportedWorkspaceEditVariant } from "../workspace/workspace-edit.ts";
import { CodeActionsUnavailable } from "./code-action.ts";
import { applyCodeActionInputSchema, previewCodeActionsInputSchema } from "./code-action-input-schemas.ts";
import { LanguageServerCodeActionsUnavailable } from "./lsp/lsp-symbol-index.ts";

const OWNER = "lector-code-action";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576 };

export const CODE_ACTION_PREVIEW_PERMISSIONS = [WORKSPACE_READ_PERMISSION];
export const CODE_ACTION_APPLY_PERMISSIONS = [WORKSPACE_WRITE_PERMISSION];

const PREVIEW_ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	{ code: "code-actions-unavailable", description: "the selected semantic backend does not support code actions" },
	{ code: "invalid-code-action-request", description: "the request exceeds a service bound or cannot fit its response envelope" },
	{ code: "stale-expected-hash", description: "the source file changed while its preview was computed" },
	{ code: "workspace-edit-outside-root", description: "the language server returned an edit outside the workspace" },
	{ code: "unsupported-workspace-edit", description: "the language server returned an unsupported WorkspaceEdit variant" },
];
const APPLY_ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	{ code: "code-action-preview-unavailable", description: "the preview is unknown, expired, or belongs to another workspace" },
	{ code: "code-action-command-denied", description: "guarded apply does not execute language-server commands" },
	{ code: "disabled-code-action", description: "the language server marked this action disabled" },
	{ code: "stale-code-action-document-version", description: "the synchronized document version changed after preview" },
	{ code: "stale-expected-hash", description: "an affected file changed after preview" },
	{ code: "overlapping-workspace-edits", description: "the action contains overlapping text edits" },
];

const mapCodeActionError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: CodeActionsUnavailable, category: "validation", code: "code-actions-unavailable" },
	{ errorClass: InvalidCodeActionRequest, category: "validation", code: "invalid-code-action-request" },
	{ errorClass: LanguageServerCodeActionsUnavailable, category: "validation", code: "code-actions-unavailable" },
	{ errorClass: CodeActionPreviewUnavailable, category: "not_found", code: "code-action-preview-unavailable" },
	{ errorClass: CodeActionCommandDenied, category: "validation", code: "code-action-command-denied" },
	{ errorClass: DisabledCodeAction, category: "conflict", code: "disabled-code-action" },
	{ errorClass: StaleCodeActionDocumentVersion, category: "conflict", code: "stale-code-action-document-version" },
	{ errorClass: StaleExpectedHash, category: "conflict", code: "stale-expected-hash" },
	{ errorClass: PathEscapesWorkspaceRoot, category: "validation", code: "workspace-edit-outside-root" },
	{ errorClass: UnsupportedWorkspaceEditVariant, category: "validation", code: "unsupported-workspace-edit" },
	{ errorClass: OverlappingWorkspaceEdits, category: "validation", code: "overlapping-workspace-edits" },
]);

/** Registers read-only preview and local-write apply with distinct permission/effect contracts. */
export function registerCodeActionOperations(operationRegistry: VehicleRegistry, registry: MutableRegistry, handlers: CodeActionHandlers): void {
	const preview = defineVehicleOperation({
		name: "workspace.previewCodeActions",
		version: 1,
		description: "Returns bounded language-server code-action previews and stores guarded apply snapshots.",
		input: previewCodeActionsInputSchema,
		output: passthroughVehicleSchema,
		permissions: CODE_ACTION_PREVIEW_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: PREVIEW_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(preview, () => (context) => mapCodeActionError(() => handlers.handlers["workspace.previewCodeActions"](registry, context.input))),
	);

	const apply = defineVehicleOperation({
		name: "workspace.applyCodeAction",
		version: 1,
		description: "Atomically applies one previewed WorkspaceEdit using version and hash guards.",
		input: applyCodeActionInputSchema,
		output: passthroughVehicleSchema,
		permissions: CODE_ACTION_APPLY_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
		errors: APPLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(apply, () => (context) => mapCodeActionError(() => handlers.handlers["workspace.applyCodeAction"](registry, context.input))),
	);
}
