import type { MutableRegistry, OperationInputs, OperationOutputs, WorkspaceId } from "../service.ts";
import { raceWorkspaceQuery } from "../workspace/race-workspace-query.ts";
import type { WorkspaceQueryOutcome } from "../workspace/workspace-query-outcome.ts";
import { UnknownWorkspace } from "./errors.ts";

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

type ResolvedTarget =
	| { readonly workspaceId: WorkspaceId; readonly valid: true }
	| { readonly workspaceId: WorkspaceId; readonly valid: false; readonly message: string };

/**
 * Resolves every requested id to either "queryable" or "immediately an error", preserving the
 * caller's own input order (or registration order, for the implicit "every registered workspace"
 * case) in one single list -- never two separately-built lists a caller has to reassemble in the
 * right relative order later. A previous version returned immediate errors and real results as
 * two lists concatenated errors-first, silently reordering the response relative to
 * input.workspaceIds whenever any id was invalid; a client correlating by array position (which
 * is exactly what a response embedding workspaceId per entry invites, and what pi-lector's own
 * zip used to do) then mislabeled every entry after the first bad one -- the real, reproduced
 * live bug this fixes.
 */
function resolveTargets(registry: MutableRegistry, explicitIds: readonly WorkspaceId[] | undefined): readonly ResolvedTarget[] {
	if (!explicitIds) return registeredWorkspaceIds(registry).map((workspaceId) => ({ workspaceId, valid: true }));
	return explicitIds.map((workspaceId) => {
		const entry = registry.get(workspaceId);
		if (!entry) return { workspaceId, valid: false, message: new UnknownWorkspace(workspaceId).message };
		if (!entry.rootPath) {
			return {
				workspaceId,
				valid: false,
				message: `workspace "${workspaceId}" has no known root path -- cross-workspace search requires workspace.registerPath or repo.fetch`,
			};
		}
		return { workspaceId, valid: true };
	});
}

async function fanOut<T>(
	targets: readonly ResolvedTarget[],
	timeoutMs: number,
	run: (workspaceId: WorkspaceId) => Promise<T>,
	loadingMessage: string,
): Promise<readonly WorkspaceQueryOutcome<T>[]> {
	return Promise.all(
		targets.map((target) =>
			target.valid
				? raceWorkspaceQuery(target.workspaceId, () => run(target.workspaceId), timeoutMs, loadingMessage)
				: Promise.resolve<WorkspaceQueryOutcome<T>>({ workspaceId: target.workspaceId, status: "error", message: target.message }),
		),
	);
}

export function createCrossWorkspaceHandlers(deps: CrossWorkspaceHandlerDeps): {
	readonly "search.symbols": (registry: MutableRegistry, input: OperationInputs["search.symbols"]) => Promise<OperationOutputs["search.symbols"]>;
	readonly "search.text": (registry: MutableRegistry, input: OperationInputs["search.text"]) => Promise<OperationOutputs["search.text"]>;
} {
	return {
		"search.symbols": async (_registry, input) => {
			const timeoutMs = input.timeoutMs ?? DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS;
			const targets = resolveTargets(deps.registry, input.workspaceIds);
			const results = await fanOut(
				targets,
				timeoutMs,
				(workspaceId) => deps.findSymbols({ workspaceId, query: input.query }),
				"this workspace's symbol index is still warming up (a cold-starting language server) -- its data may exist once it finishes; retry shortly",
			);
			return { results };
		},
		"search.text": async (_registry, input) => {
			const timeoutMs = input.timeoutMs ?? DEFAULT_CROSS_WORKSPACE_TIMEOUT_MS;
			const targets = resolveTargets(deps.registry, input.workspaceIds);
			const results = await fanOut(
				targets,
				timeoutMs,
				(workspaceId) => deps.searchText({ workspaceId, query: input.query, maxMatches: input.maxMatches, maxBytes: input.maxBytes }),
				"this workspace's search is still running -- its data may exist once it finishes; retry shortly",
			);
			return { results };
		},
	};
}
