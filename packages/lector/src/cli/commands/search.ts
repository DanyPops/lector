import { connectLectorClient } from "../../client.ts";
import { DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS } from "../../external-search/external-search-result.ts";
import { collectFlagValues, fail, flagValue, hasFlag, requiredIntFlag } from "../flags.ts";
import { USAGE } from "../usage.ts";

/** search.symbols/text/githubRepos/npmPackages/sourcegraphCode -- cross-workspace and external search. */

export async function runSearchSymbols(query: string | undefined, flags: string[]): Promise<void> {
	if (!query) fail(USAGE);
	const timeoutMs = flagValue(flags, "--timeout-ms");
	const workspaceIds = collectFlagValues(flags, "--workspace");
	const client = await connectLectorClient();
	const { results } = await client.call("search.symbols", {
		query,
		workspaceIds: workspaceIds.length === 0 ? undefined : workspaceIds,
		timeoutMs: timeoutMs === undefined ? undefined : Number(timeoutMs),
	});
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(results));
		return;
	}
	if (results.length === 0) {
		console.log("no workspaces registered with a known root to search");
		return;
	}
	for (const outcome of results) {
		if (outcome.status === "loading") {
			console.log(`${outcome.workspaceId}: still loading -- ${outcome.message}`);
			continue;
		}
		if (outcome.status === "error") {
			console.log(`${outcome.workspaceId}: error -- ${outcome.message}`);
			continue;
		}
		if (outcome.result.symbols.length === 0) {
			console.log(`${outcome.workspaceId}: no symbols matched "${query}"`);
			continue;
		}
		for (const symbol of outcome.result.symbols) {
			console.log(`${outcome.workspaceId}: ${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`);
		}
	}
}

export async function runSearchText(query: string | undefined, flags: string[]): Promise<void> {
	if (!query) fail(USAGE);
	const maxMatches = requiredIntFlag(flags, "--max-matches");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const timeoutMs = flagValue(flags, "--timeout-ms");
	const workspaceIds = collectFlagValues(flags, "--workspace");
	const client = await connectLectorClient();
	const { results } = await client.call("search.text", {
		query,
		maxMatches,
		maxBytes,
		workspaceIds: workspaceIds.length === 0 ? undefined : workspaceIds,
		timeoutMs: timeoutMs === undefined ? undefined : Number(timeoutMs),
	});
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(results));
		return;
	}
	if (results.length === 0) {
		console.log("no workspaces registered with a known root to search");
		return;
	}
	for (const outcome of results) {
		if (outcome.status === "loading") {
			console.log(`${outcome.workspaceId}: still loading -- ${outcome.message}`);
			continue;
		}
		if (outcome.status === "error") {
			console.log(`${outcome.workspaceId}: error -- ${outcome.message}`);
			continue;
		}
		if (outcome.result.matches.length === 0) {
			console.log(`${outcome.workspaceId}: no matches for "${query}"`);
			continue;
		}
		for (const match of outcome.result.matches) {
			console.log(`${outcome.workspaceId}: ${match.path}:${match.lineNumber}: ${match.line.replace(/\n$/, "")}`);
		}
		if (outcome.result.truncated) console.log(`${outcome.workspaceId}: ... (truncated)`);
	}
}

export async function runSearchGithubRepos(query: string | undefined, flags: string[]): Promise<void> {
	if (!query) fail(USAGE);
	const maxResults = Number(flagValue(flags, "--max-results") ?? String(DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS));
	const client = await connectLectorClient();
	const result = await client.call("search.githubRepos", { query, maxResults });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (!result.authenticated) console.log("note: unauthenticated -- configure GITHUB_TOKEN for a much higher rate limit");
	if (result.candidates.length === 0) {
		console.log(`no repositories matched "${query}"`);
		return;
	}
	for (const candidate of result.candidates) {
		console.log(
			`${candidate.owner}/${candidate.repo} (${candidate.stars}★${candidate.language ? `, ${candidate.language}` : ""}) -- ${candidate.description ?? "no description"}`,
		);
	}
}

export async function runSearchNpmPackages(query: string | undefined, flags: string[]): Promise<void> {
	if (!query) fail(USAGE);
	const maxResults = Number(flagValue(flags, "--max-results") ?? String(DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS));
	const client = await connectLectorClient();
	const { candidates } = await client.call("search.npmPackages", { query, maxResults });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify({ candidates }));
		return;
	}
	if (candidates.length === 0) {
		console.log(`no packages matched "${query}"`);
		return;
	}
	for (const candidate of candidates) {
		console.log(
			`${candidate.name}@${candidate.version} (score ${candidate.score.toFixed(2)}) -- ${candidate.description ?? "no description"}${candidate.repositoryUrl ? ` -- ${candidate.repositoryUrl}` : ""}`,
		);
	}
}

export async function runSearchSourcegraphCode(query: string | undefined, flags: string[]): Promise<void> {
	if (!query) fail(USAGE);
	const maxResults = Number(flagValue(flags, "--max-results") ?? String(DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS));
	const client = await connectLectorClient();
	const result = await client.call("search.sourcegraphCode", { query, maxResults });
	const { candidates } = result;
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (candidates.length === 0) {
		console.log(`no code matches for "${query}"`);
		return;
	}
	for (const candidate of candidates) {
		console.log(
			`${candidate.repository} -- ${candidate.path}${candidate.lineMatches.length > 0 ? ` (${candidate.lineMatches.length} matching lines)` : ""} -- ${candidate.url}`,
		);
	}
	if (result.truncated) console.log(`partial results -- ${result.stopReason ?? "bounded"}`);
}

const SEARCH_ACTIONS: Record<string, (query: string | undefined, flags: string[]) => Promise<void>> = {
	symbols: runSearchSymbols,
	text: runSearchText,
	"github-repos": runSearchGithubRepos,
	"npm-packages": runSearchNpmPackages,
	"sourcegraph-code": runSearchSourcegraphCode,
};

export async function runSearch(rest: string[]): Promise<void> {
	const [action, query, ...searchFlags] = rest;
	const handler = action ? SEARCH_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(query, searchFlags);
}
