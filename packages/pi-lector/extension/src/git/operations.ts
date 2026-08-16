import type { GitDiffResult, GitLogEntry, GitStatusSummary, OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

type SymbolComparison = OperationOutputs["workspace.compareSymbolAcrossVersions"];

/** Matches GIT_READ_PERMISSIONS' own declared value server-side (git/operation-registration.ts). */
const GIT_READ_PERMISSIONS = ["workspace:read"];

/**
 * Thin wrappers over Lector's read-only git operations. `directory` is
 * required, same convention as find_symbols -- no implicit "whatever the
 * session's cwd is" fallback.
 *
 * status/log/diff dispatch through invokeLectorVehicleOperation (the real VehicleRegistry-backed
 * workspace.gitStatus/gitLog/gitDiff operations -- see Lector Phase 1/2 of the vehicle-client-pi
 * adoption epic) instead of a bare lectorClient().call(), gaining activity broadcasting, the
 * local /safety ask gate, and idempotency-key/correlationId derivation for free. compareSymbol
 * (workspace.compareSymbolAcrossVersions) has not migrated onto VehicleRegistry server-side yet,
 * so it stays on the legacy dispatch unchanged.
 */
export interface GitOperations {
	status(directory: string, call: LectorVehicleCall): Promise<GitStatusSummary>;
	log(directory: string, maxCount: number, call: LectorVehicleCall): Promise<readonly GitLogEntry[]>;
	diff(directory: string, ref: string | undefined, maxBytes: number, call: LectorVehicleCall): Promise<GitDiffResult>;
	compareSymbol(directory: string, path: string, symbolName: string, fromRef: string, toRef: string | undefined, maxBytes: number): Promise<SymbolComparison>;
}

export function createLectorGitOperations(): GitOperations {
	return {
		async status(directory, call) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				({ workspaceId }) => invokeLectorVehicleOperation<GitStatusSummary>("workspace.gitStatus", { workspaceId }, GIT_READ_PERMISSIONS, call),
			);
		},
		async log(directory, maxCount, call) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const { entries } = await invokeLectorVehicleOperation<{ entries: readonly GitLogEntry[] }>(
						"workspace.gitLog",
						{ workspaceId, maxCount },
						GIT_READ_PERMISSIONS,
						call,
					);
					return entries;
				},
			);
		},
		async diff(directory, ref, maxBytes, call) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				({ workspaceId }) => invokeLectorVehicleOperation<GitDiffResult>("workspace.gitDiff", { workspaceId, ref, maxBytes }, GIT_READ_PERMISSIONS, call),
			);
		},
		async compareSymbol(directory, path, symbolName, fromRef, toRef, maxBytes) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.compareSymbolAcrossVersions", { workspaceId, path, symbolName, fromRef, toRef, maxBytes });
				},
			);
		},
	};
}
