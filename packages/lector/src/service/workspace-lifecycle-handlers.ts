import { UnknownWorkspace, type WorkspaceId, WorkspaceReleaseBlocked } from "./errors.ts";
import { GraphRefreshJobActive } from "./graph-refresh-coordinator.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { WarmIndexInUse, type WarmIndexRegistry } from "./warm-index-registry.ts";
import type { MutableRegistry } from "./workspace-registry.ts";
import type { WorkspaceWatchHandlers } from "./workspace-watch-handlers.ts";

interface WorkspaceGraphRelease {
	releaseWorkspaceIfIdle(workspaceId: WorkspaceId): Promise<boolean>;
}

export interface WorkspaceLifecycleHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly graphRefresh: WorkspaceGraphRelease;
	readonly watchHandlers: Pick<WorkspaceWatchHandlers, "hasActiveWatch" | "releaseWorkspace">;
}

export interface WorkspaceLifecycleHandlers {
	"workspace.release": (registry: MutableRegistry, input: OperationInputs["workspace.release"]) => Promise<OperationOutputs["workspace.release"]>;
}

/**
 * workspace.release -- the missing counterpart to workspace.registerPath/repo.fetch/
 * package.resolveSource: lets a temporary, fetched, or package-source workspace actually leave
 * the registry within the same daemon lifetime that created it, instead of only ever growing
 * until restart. Refuses (WorkspaceReleaseBlocked) while anything is still actively using this
 * workspace -- a warm index lease, an in-flight populateSymbolGraph job, or a live
 * workspace.watch subscription -- rather than silently tearing it down from underneath real
 * work. Every check runs before any teardown, so a refusal never leaves the workspace
 * half-released.
 */
export function createWorkspaceLifecycleHandlers(deps: WorkspaceLifecycleHandlerDeps): WorkspaceLifecycleHandlers {
	return {
		async "workspace.release"(registry, input) {
			if (!registry.has(input.workspaceId)) throw new UnknownWorkspace(input.workspaceId);
			if (deps.watchHandlers.hasActiveWatch(input.workspaceId)) throw new WorkspaceReleaseBlocked(input.workspaceId, "active-watch");

			let closedIndexes: number;
			try {
				closedIndexes = (await deps.warmIndexes.releaseWorkspaceIfIdle(input.workspaceId)).closed;
			} catch (error) {
				if (error instanceof WarmIndexInUse) throw new WorkspaceReleaseBlocked(input.workspaceId, "active-lease");
				throw error;
			}

			let closedGraph: boolean;
			try {
				closedGraph = await deps.graphRefresh.releaseWorkspaceIfIdle(input.workspaceId);
			} catch (error) {
				if (error instanceof GraphRefreshJobActive) throw new WorkspaceReleaseBlocked(input.workspaceId, "active-job");
				throw error;
			}

			const closedWatch = deps.watchHandlers.releaseWorkspace(input.workspaceId);
			registry.delete(input.workspaceId);
			return { workspaceId: input.workspaceId, closedIndexes, closedGraph, closedWatch };
		},
	};
}
