import type { GitDiffResult, GitLogEntry, GitStatusSummary, OperationOutputs } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "./lector-client.ts";

type SymbolComparison = OperationOutputs["workspace.compareSymbolAcrossVersions"];

/**
 * Thin wrappers over Lector's read-only git operations. `directory` is
 * required, same convention as find_symbols -- no implicit "whatever the
 * session's cwd is" fallback.
 */
export interface GitOperations {
	status(directory: string): Promise<GitStatusSummary>;
	log(directory: string, maxCount: number): Promise<readonly GitLogEntry[]>;
	diff(directory: string, ref: string | undefined, maxBytes: number): Promise<GitDiffResult>;
	compareSymbol(directory: string, path: string, symbolName: string, fromRef: string, toRef: string | undefined, maxBytes: number): Promise<SymbolComparison>;
}

export function createLectorGitOperations(): GitOperations {
	return {
		async status(directory) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.gitStatus", { workspaceId });
				},
			);
		},
		async log(directory, maxCount) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { entries } = await client.call("workspace.gitLog", { workspaceId, maxCount });
					return entries;
				},
			);
		},
		async diff(directory, ref, maxBytes) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.gitDiff", { workspaceId, ref, maxBytes });
				},
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
