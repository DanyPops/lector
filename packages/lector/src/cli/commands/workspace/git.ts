import { connectLectorClient } from "../../../client.ts";
import { fail, flagValue, hasFlag, requiredIntFlag } from "../../flags.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";


/** gitStatus/gitLog/gitDiff/compareSymbolAcrossVersions -- mirrors service/git-handlers.ts's own scope. */

export async function runWorkspaceGitStatus(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const client = await connectLectorClient();
	const summary = await client.call("workspace.gitStatus", { workspaceId });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(summary));
		return;
	}
	const branch = summary.current ?? "(detached)";
	const tracking = summary.tracking ? `, tracking ${summary.tracking} (+${summary.ahead}/-${summary.behind})` : "";
	console.log(`On branch ${branch}${tracking}`);
	if (summary.files.length === 0) {
		console.log("working tree clean");
		return;
	}
	for (const file of summary.files) {
		const code = `${file.indexStatus}${file.workingDirStatus}`;
		console.log(file.renamedFrom ? `${code} ${file.renamedFrom} -> ${file.path}` : `${code} ${file.path}`);
	}
}

export async function runWorkspaceGitLog(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxCount = requiredIntFlag(flags, "--max-count");
	const client = await connectLectorClient();
	const { entries } = await client.call("workspace.gitLog", { workspaceId, maxCount });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(entries));
		return;
	}
	for (const entry of entries) console.log(`${entry.sha.slice(0, 8)} ${entry.authoredAt} ${entry.authorName} -- ${entry.message}`);
}

export async function runWorkspaceGitDiff(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const ref = flagValue(flags, "--ref");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.gitDiff", { workspaceId, ref, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(result.diff);
	if (result.truncated) console.log("... (truncated)");
}

export async function runWorkspaceCompareSymbol(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const path = flagValue(flags, "--path");
	const symbolName = flagValue(flags, "--symbol");
	const fromRef = flagValue(flags, "--from-ref");
	if (!path || !symbolName || !fromRef) fail(USAGE);
	const toRef = flagValue(flags, "--to-ref");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.compareSymbolAcrossVersions", { workspaceId, path, symbolName, fromRef, toRef, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(`${result.status}: ${result.path} (${result.symbolName}) ${result.fromRef} -> ${result.toRef}`);
	if (result.diff) console.log(result.diff);
	if (result.truncated) console.log("... (truncated)");
}

export const GIT_ACTIONS: Record<string, ActionHandler> = {
	"git-status": (actionArgs) => {
		// None of git-status/git-log/git-diff take a <path> positional -- a generic
		// [workspaceId, path, ...flags] destructure would misparse the first flag as path (the exact
		// bug populate-symbol-graph's own CLI wiring hit).
		const [gitWorkspaceId, ...gitFlags] = actionArgs;
		return runWorkspaceGitStatus(gitWorkspaceId, gitFlags);
	},
	"git-log": (actionArgs) => {
		const [gitWorkspaceId, ...gitFlags] = actionArgs;
		return runWorkspaceGitLog(gitWorkspaceId, gitFlags);
	},
	"git-diff": (actionArgs) => {
		const [gitWorkspaceId, ...gitFlags] = actionArgs;
		return runWorkspaceGitDiff(gitWorkspaceId, gitFlags);
	},
	"compare-symbol": (actionArgs) => {
		// Same reasoning as git-status/git-log/git-diff above -- --path is a flag here, not a positional.
		const [csWorkspaceId, ...csFlags] = actionArgs;
		return runWorkspaceCompareSymbol(csWorkspaceId, csFlags);
	},
};
