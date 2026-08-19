import type { GitDiffResult, GitLogEntry, GitStatusSummary, OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

type SymbolComparison = OperationOutputs["workspace.compareSymbolAcrossVersions"];
type GitWorktreeAddResult = OperationOutputs["workspace.gitWorktreeAdd"];
type GitWorktreeRemoveResult = OperationOutputs["workspace.gitWorktreeRemove"];

/** Matches GIT_READ_PERMISSIONS' own declared value server-side (git/operation-registration.ts). */
const GIT_READ_PERMISSIONS = ["workspace:read"];
/** Matches GIT_WORKTREE_WRITE_PERMISSIONS' own declared value server-side (git/operation-registration.ts). */
const GIT_WORKTREE_WRITE_PERMISSIONS = ["workspace:write"];

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
	/**
	 * Materializes a real, disposable, read-only project at `ref` via a detached git worktree.
	 * The returned `path` is a real directory every other pi-lector tool already accepts as its
	 * own `directory` argument (find_symbols, search_code, git itself, ...) -- no separate
	 * workspaceId ever needs to reach the agent.
	 */
	worktreeAdd(directory: string, ref: string, forceRefresh: boolean | undefined, call: LectorVehicleCall): Promise<GitWorktreeAddResult>;
	/** `directory` is the worktree's own path (worktreeAdd's returned `path`), not the source repo's -- it resolves to the exact same workspace via the same git-root walk every other tool already uses. */
	worktreeRemove(directory: string, call: LectorVehicleCall): Promise<GitWorktreeRemoveResult>;
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
		async worktreeAdd(directory, ref, forceRefresh, call) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				({ workspaceId }) =>
					invokeLectorVehicleOperation<GitWorktreeAddResult>(
						"workspace.gitWorktreeAdd",
						{ workspaceId, ref, forceRefresh },
						GIT_WORKTREE_WRITE_PERMISSIONS,
						call,
					),
			);
		},
		async worktreeRemove(directory, call) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				({ workspaceId }) =>
					invokeLectorVehicleOperation<GitWorktreeRemoveResult>("workspace.gitWorktreeRemove", { workspaceId }, GIT_WORKTREE_WRITE_PERMISSIONS, call),
			);
		},
	};
}
