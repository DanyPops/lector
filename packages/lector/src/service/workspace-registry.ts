import type { RepoReference } from "../repo-fetcher/repo-reference.ts";
import type { FileTreePort } from "../workspace/file-tree-port.ts";
import type { WorkspacePort } from "../workspace/port.ts";
import { UnknownWorkspace, WorkspaceDoesNotSupportFileTree, type WorkspaceId } from "./errors.ts";

export interface RegisteredWorkspace {
	readonly port: WorkspacePort;
	/** Present only for workspaces registered via workspace.registerPath -- required for symbol queries. */
	readonly rootPath?: string;
	/** Local work always outranks disposable fetched-repo work in the bounded job queue. */
	readonly origin: "local" | "remote";
	/** Present only for a workspace registered via repo.fetch -- the reference to re-check/refetch when its remote moves. */
	readonly remoteReference?: RepoReference;
}

export type MutableRegistry = Map<WorkspaceId, RegisteredWorkspace>;

export function resolveWorkspace(registry: MutableRegistry, workspaceId: WorkspaceId): WorkspacePort {
	const entry = registry.get(workspaceId);
	if (!entry) throw new UnknownWorkspace(workspaceId);
	return entry.port;
}

/** True when a WorkspacePort also implements FileTreePort -- mirrors supportsCodeIntelligence's own duck-typed capability check below. */
function supportsFileTree(port: WorkspacePort): port is WorkspacePort & FileTreePort {
	return "listDirectory" in port && typeof port.listDirectory === "function";
}

export function resolveFileTree(registry: MutableRegistry, workspaceId: WorkspaceId): FileTreePort {
	const port = resolveWorkspace(registry, workspaceId);
	if (!supportsFileTree(port)) throw new WorkspaceDoesNotSupportFileTree(workspaceId);
	return port;
}

export { WorkspaceDoesNotSupportFileTree };
