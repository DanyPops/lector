import { connectLectorClient } from "../../../client.ts";
import { fail, hasFlag, requiredIntFlag } from "../../flags.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";

/** mutationHistory/revertMutation/mutationTransaction/revertMutationTransaction -- mirrors service/mutation-history-handlers.ts's own scope (the history/revert queries, distinct from workspace-file-handlers.ts's own raw edit/delete/apply-patch primitives). */

export async function runWorkspaceMutationHistory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const maxResults = requiredIntFlag(flags, "--max-results");
	const client = await connectLectorClient();
	const { entries } = await client.call("workspace.mutationHistory", { workspaceId, path, maxResults });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(entries));
		return;
	}
	if (entries.length === 0) {
		console.log("no recorded mutation history for this path");
		return;
	}
	for (const entry of entries) console.log(`${entry.id}  ${new Date(entry.timestamp).toISOString()}  ${entry.operation}`);
}

export async function runWorkspaceRevertMutation(workspaceId: string | undefined, entryId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !entryId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.revertMutation", { workspaceId, entryId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path} reverted -> ${result.newHash ?? "(deleted)"}`);
}

export async function runWorkspaceMutationTransaction(workspaceId: string | undefined, transactionId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !transactionId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.mutationTransaction", { workspaceId, transactionId });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	switch (result.status) {
		case "ready":
		case "stale":
			console.log(`transaction ${result.status}${result.stalePaths.length > 0 ? ` (${result.stalePaths.length} stale path(s))` : ""}`);
			for (const entry of result.entries) console.log(`${entry.path}  ${entry.id}  ${new Date(entry.timestamp).toISOString()}`);
			return;
		case "evicted":
			console.log("transaction history was evicted from bounded process-local retention");
			return;
		case "wrong-workspace":
			console.log("transaction belongs to a different registered workspace");
			return;
		case "unknown":
			console.log("transaction is unknown or its process-local history was lost after restart");
			return;
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

export async function runWorkspaceRevertMutationTransaction(
	workspaceId: string | undefined,
	transactionId: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !transactionId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.revertMutationTransaction", { workspaceId, transactionId });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	for (const entry of result.reverted) console.log(`${entry.path} reverted -> ${entry.newHash ?? "(deleted)"}`);
}

export const MUTATION_ACTIONS: Record<string, ActionHandler> = {
	"mutation-history": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceMutationHistory(workspaceId, path, flags);
	},
	"revert-mutation": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceRevertMutation(workspaceId, path, flags);
	},
	"mutation-transaction": (actionArgs) => {
		const [workspaceId, transactionId, ...flags] = actionArgs;
		return runWorkspaceMutationTransaction(workspaceId, transactionId, flags);
	},
	"revert-mutation-transaction": (actionArgs) => {
		const [workspaceId, transactionId, ...flags] = actionArgs;
		return runWorkspaceRevertMutationTransaction(workspaceId, transactionId, flags);
	},
};
