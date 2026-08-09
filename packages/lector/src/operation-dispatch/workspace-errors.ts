/** Workspace-resolving operations share one stable error contract. */
import { UnknownWorkspace } from "../service/errors.ts";

export const UNKNOWN_WORKSPACE_ERROR_MAPPING = { errorClass: UnknownWorkspace, category: "not_found" as const, code: "unknown-workspace" };
export const UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR = {
	code: "unknown-workspace",
	description: "workspaceId names no workspace registered via workspace.registerPath",
};
