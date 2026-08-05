import type { MutableRegistry, OperationInputs, OperationOutputs, WorkspaceId } from "../service.ts";
import { raceWorkspaceQuery } from "../workspace/race-workspace-query.ts";

const DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS = 3000;

export interface CrossWorkspaceHandlerDeps {
	readonly registry: MutableRegistry;
	readonly findSymbols: (input: OperationInputs["workspace.findSymbols"]) => Promise<OperationOutputs["workspace.findSymbols"]>;
	readonly searchText: (input: OperationInputs["workspace.searchText"]) => Promise<OperationOutputs["workspace.searchText"]>;
}

function registeredWorkspaceIds(registry: MutableRegistry): readonly WorkspaceId[] {
	return Array.from(registry.entries())
		.filter(([, entry]) => entry.rootPath !== undefined)
		.map(([workspaceId]) => workspaceId);
}

function resolveTargets(
	registry: MutableRegistry,
	explicitIds: readonly WorkspaceId[] | undefined,
): { targets: readonly WorkspaceId[]; immediateErrors: readonly { workspaceId: WorkspaceId; status: "error"; message: string }[] } {
	if (!explicitIds) return { targets: registeredWorkspaceIds(registry), immediateErrors: [] };
	const targets: WorkspaceId[] = [];
	const immediateErrors: { workspaceId: WorkspaceId; status: "error"; message: string }[] = [];
	for (const workspaceId of explicitIds) {
		const entry = registry.get(workspaceId);
		if (!entry) {
			immediateErrors.push({ workspaceId, status: "error", message: `no workspace registered under id "${workspaceId}"` });
		} else if (!entry.rootPath) {
			immediateErrors.push({
				workspaceId,
				status: "error",
				message: `workspace "${workspaceId}" has no known root path -- cross-workspace search requires workspace.registerPath or repo.fetch`,
			});
		} else {
			targets.push(workspaceId);
		}
	}
	return { targets, immediateErrors };
}

export function createCrossWorkspaceHandlers(deps: CrossWorkspaceHandlerDeps): {
	readonly "search.symbols": (registry: MutableRegistry, input: OperationInputs["search.symbols"]) => Promise<OperationOutputs["search.symbols"]>;
	readonly "search.text": (registry: MutableRegistry, input: OperationInputs["search.text"]) => Promise<OperationOutputs["search.text"]>;
} {
	return {
		"search.symbols": async (_registry, input) => {
			const timeoutMs = input.timeoutMs ?? DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS;
			const { targets, immediateErrors } = resolveTargets(deps.registry, input.workspaceIds);
			const results = await Promise.all(
				targets.map((workspaceId) =>
					raceWorkspaceQuery(
						workspaceId,
						() => deps.findSymbols({ workspaceId, query: input.query }),
						timeoutMs,
						"this workspace's symbol index is still warming up (a cold-starting language server) -- its data may exist once it finishes; retry shortly",
					),
				),
			);
			return { results: [...immediateErrors, ...results] };
		},
		"search.text": async (_registry, input) => {
			const timeoutMs = input.timeoutMs ?? DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS;
			const { targets, immediateErrors } = resolveTargets(deps.registry, input.workspaceIds);
			const results = await Promise.all(
				targets.map((workspaceId) =>
					raceWorkspaceQuery(
						workspaceId,
						() => deps.searchText({ workspaceId, query: input.query, maxMatches: input.maxMatches, maxBytes: input.maxBytes }),
						timeoutMs,
						"this workspace's search is still running -- its data may exist once it finishes; retry shortly",
					),
				),
			);
			return { results: [...immediateErrors, ...results] };
		},
	};
}
