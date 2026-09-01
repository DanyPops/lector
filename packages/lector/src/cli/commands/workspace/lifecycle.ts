import { connectLectorClient } from "../../../client.ts";
import { fail, hasFlag } from "../../flags.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";

async function runWorkspaceRelease(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.release", { workspaceId });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(
		`released ${result.workspaceId} -- ${result.closedIndexes} index(es), graph ${result.closedGraph ? "closed" : "idle"}, watch ${result.closedWatch ? "closed" : "idle"}`,
	);
}

export const LIFECYCLE_ACTIONS: Record<string, ActionHandler> = {
	release: (actionArgs) => {
		const [workspaceId, ...flags] = actionArgs;
		return runWorkspaceRelease(workspaceId, flags);
	},
};
