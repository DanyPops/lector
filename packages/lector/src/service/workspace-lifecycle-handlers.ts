import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertAbsolutePath } from "../path-safety/assert-absolute-path.ts";
import { LocalFilesystemWorkspace } from "../workspace/local-filesystem-workspace.ts";
import { resolveWorkspacePath } from "../workspace/resolve-workspace-path.ts";
import { deriveWorkspaceId, InvalidWorkspaceRoot, UnknownWorkspace, type WorkspaceId, WorkspaceReleaseBlocked } from "./errors.ts";
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
	readonly releaseTextSearch?: (rootPath: string) => void;
}

export interface WorkspaceLifecycleHandlers {
	"workspace.release": (registry: MutableRegistry, input: OperationInputs["workspace.release"]) => Promise<OperationOutputs["workspace.release"]>;
	"workspace.registerPath": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.registerPath"],
	) => Promise<OperationOutputs["workspace.registerPath"]>;
	"workspace.resolvePath": (registry: MutableRegistry, input: OperationInputs["workspace.resolvePath"]) => Promise<OperationOutputs["workspace.resolvePath"]>;
}

async function resolvePathHandler(
	registry: MutableRegistry,
	input: OperationInputs["workspace.resolvePath"],
): Promise<OperationOutputs["workspace.resolvePath"]> {
	// Same rejection as registerPath -- a daemon has no caller-relative cwd of its own.
	assertAbsolutePath(input.path);
	const outcome = resolveWorkspacePath({ ...input, path: resolve(input.path) });
	if (!outcome.found) return { found: false, reason: outcome.reason };
	const { workspaceId, created } = await registerPath(registry, { path: outcome.root });
	return { found: true, workspaceId, root: outcome.root, created };
}

async function registerPath(registry: MutableRegistry, input: OperationInputs["workspace.registerPath"]): Promise<OperationOutputs["workspace.registerPath"]> {
	// Rejected outright, not resolved -- a daemon has no caller-relative "current directory" of
	// its own; resolve() on a relative path would silently use this PROCESS's own cwd (e.g. a
	// systemd unit's fixed WorkingDirectory), not whatever the real caller actually meant.
	assertAbsolutePath(input.path);
	const absolutePath = resolve(input.path);
	const workspaceId = deriveWorkspaceId(absolutePath);
	if (registry.has(workspaceId)) {
		return { workspaceId, created: false };
	}

	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(absolutePath);
	} catch {
		throw new InvalidWorkspaceRoot(absolutePath, "path does not exist or is not accessible");
	}
	if (!stats.isDirectory()) {
		throw new InvalidWorkspaceRoot(absolutePath, "path is not a directory");
	}

	registry.set(workspaceId, { port: new LocalFilesystemWorkspace(absolutePath), rootPath: absolutePath, origin: "local" });
	return { workspaceId, created: true };
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
			const entry = registry.get(input.workspaceId);
			if (!entry) throw new UnknownWorkspace(input.workspaceId);
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
			if (entry.rootPath) deps.releaseTextSearch?.(entry.rootPath);
			registry.delete(input.workspaceId);
			return { workspaceId: input.workspaceId, closedIndexes, closedGraph, closedWatch };
		},
		"workspace.registerPath": registerPath,
		"workspace.resolvePath": resolvePathHandler,
	};
}
