/** UnknownWorkspace is reachable from every operation that resolves a workspaceId -- shared here so each migrated module declares it once, not as its own copy of the same mapping/descriptor. */
import { UnknownWorkspace } from "../errors.ts";

export const UNKNOWN_WORKSPACE_ERROR_MAPPING = { errorClass: UnknownWorkspace, category: "not_found" as const, code: "unknown-workspace" };
export const UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR = {
	code: "unknown-workspace",
	description: "workspaceId names no workspace registered via workspace.registerPath",
};
