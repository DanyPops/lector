import { connectLectorClient } from "../../../client.ts";
import { fail, flagValue, hasFlag, parseRepoSpec, requiredIntFlag } from "../../flags.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";


/** repo.fetch/evictCache/listCache -- mirrors service/repo-fetch-handlers.ts's own scope. */

export async function runWorkspaceRepoFetch(spec: string | undefined, flags: string[]): Promise<void> {
	if (!spec) fail(USAGE);
	const host = flagValue(flags, "--host") ?? "github.com";
	const reference = parseRepoSpec(spec, host);
	const forceRefresh = hasFlag(flags, "--force-refresh");
	const client = await connectLectorClient();
	const result = await client.call("repo.fetch", { ...reference, forceRefresh });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(`${result.workspaceId} ${result.fromCache ? "(from cache)" : "(fetched)"} -- ${result.path}`);
	if (result.refFallbackOccurred) console.log(`note: requested ref not found, fell back to the default branch (resolved: ${result.resolvedRef})`);
}

export async function runWorkspaceRepoCacheEvict(spec: string | undefined, flags: string[]): Promise<void> {
	if (!spec) fail(USAGE);
	const host = flagValue(flags, "--host") ?? "github.com";
	const reference = parseRepoSpec(spec, host);
	const client = await connectLectorClient();
	const result = await client.call("repo.evictCache", reference);
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(result.evicted ? "evicted" : "nothing cached for that reference");
}

export async function runWorkspaceRepoCacheList(flags: string[]): Promise<void> {
	const maxResults = requiredIntFlag(flags, "--max-results");
	const host = flagValue(flags, "--host");
	const owner = flagValue(flags, "--owner");
	const repo = flagValue(flags, "--repo");
	const ref = flagValue(flags, "--ref");
	const text = flagValue(flags, "--query");
	const cursor = flagValue(flags, "--cursor");
	const client = await connectLectorClient();
	const page = await client.call("repo.listCache", { maxResults, host, owner, repo, ref, text, cursor });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(page));
		return;
	}
	if (page.entries.length === 0) {
		console.log("no cached repositories");
		return;
	}
	for (const entry of page.entries) {
		const registered = entry.registeredWorkspaceId ? `registered as ${entry.registeredWorkspaceId}` : "not registered";
		console.log(
			`${entry.host}/${entry.owner}/${entry.repo}@${entry.requestedRef} (resolved ${entry.resolvedRef} ${entry.commit.slice(0, 12)}) -- ${entry.path} -- ${registered}`,
		);
	}
	if (page.nextCursor) console.log(`--cursor ${page.nextCursor} for more`);
}

export const REPO_CACHE_ACTIONS: Record<string, ActionHandler> = {
	"repo-fetch": (actionArgs) => {
		const [spec, ...repoFlags] = actionArgs;
		return runWorkspaceRepoFetch(spec, repoFlags);
	},
	"repo-cache-list": (actionArgs) => runWorkspaceRepoCacheList(actionArgs),
	"repo-cache-evict": (actionArgs) => {
		const [spec, ...evictFlags] = actionArgs;
		return runWorkspaceRepoCacheEvict(spec, evictFlags);
	},
};
