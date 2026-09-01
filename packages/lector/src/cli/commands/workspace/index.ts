import { fail } from "../../flags.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";
import { runWorkspaceAnnotation } from "./annotation.ts";
import { CODE_INTELLIGENCE_ACTIONS } from "./code-intelligence.ts";
import { FILE_OPS_ACTIONS } from "./file-ops.ts";
import { GIT_ACTIONS } from "./git.ts";
import { LIFECYCLE_ACTIONS } from "./lifecycle.ts";
import { MUTATION_ACTIONS } from "./mutation.ts";
import { REPO_CACHE_ACTIONS } from "./repo-cache.ts";
import { SYMBOL_GRAPH_ACTIONS } from "./symbol-graph.ts";

// Every entry re-derives whatever slice of actionArgs it needs itself (rather than sharing one
// upfront [workspaceId, path, ...flags] destructure the way the old if-chain did) -- each action is
// independently addressable via WORKSPACE_ACTIONS[action], so nothing upstream is in scope to share.
// Composed from the 7 sub-concern action maps (file-ops/code-intelligence/git/lifecycle/mutation/
// symbol-graph/repo-cache), file-for-file mirroring service/'s own segmentation -- annotation is its own nested
// dispatcher (`lector workspace annotation <subcommand>`), not a flat action.
const WORKSPACE_ACTIONS: Record<string, ActionHandler> = {
	...FILE_OPS_ACTIONS,
	...CODE_INTELLIGENCE_ACTIONS,
	...GIT_ACTIONS,
	...LIFECYCLE_ACTIONS,
	...MUTATION_ACTIONS,
	...SYMBOL_GRAPH_ACTIONS,
	...REPO_CACHE_ACTIONS,
	annotation: (actionArgs) => runWorkspaceAnnotation(actionArgs),
};

export async function runWorkspace(rest: string[]): Promise<void> {
	const [action, ...actionArgs] = rest;
	const handler = action ? WORKSPACE_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(actionArgs);
}
