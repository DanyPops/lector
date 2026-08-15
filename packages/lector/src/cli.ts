#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPushChannel } from "@danypops/vehicle-client/daemon-client";
import { createLogger } from "@danypops/vehicle-server/logging";
import { createServiceCli, type ServiceSpec } from "@danypops/vehicle-server/service";
import { connectLectorClient, resolveLectorDaemonConnection } from "./client.ts";
import type { JobSnapshot } from "./concurrency/bounded-job-executor.ts";
import type { PopulateSymbolGraphResult } from "./symbol-graph/populate-symbol-graph.ts";
import { runWorkspace } from "./cli/commands/workspace/index.ts";
import {
	collectFlagValues,
	fail,
	flagValue,
	hasFlag,
	nonNegativeIntegerFlag,
	parseEcosystemFlag,
	parseWorkspacePathFlag,
	positiveIntegerFlag,
	requireEcosystem,
	requiredIntFlag,
} from "./cli/flags.ts";
import { formatJobSnapshot, formatPackageSourceListEntry, formatPackageSourceResult } from "./cli/format.ts";
import { USAGE } from "./cli/usage.ts";
import { resolveLectorPaths } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import { DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS } from "./external-search/external-search-result.ts";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS } from "./package-source/package-source.ts";
import type { WorkspaceId } from "./service.ts";
import { lectorVersion } from "./version.ts";
import { InMemoryWorkspace } from "./workspace/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "./workspace/local-filesystem-workspace.ts";
import type { WorkspacePort } from "./workspace/port.ts";


async function runServe(args: string[]): Promise<void> {
	const memoryIds = collectFlagValues(args, "--workspace");
	const pathEntries = collectFlagValues(args, "--workspace-path").map(parseWorkspacePathFlag);
	const dynamicWorkspaces = hasFlag(args, "--dynamic-workspaces");
	const symbolIndexMemoryBudgetBytes = positiveIntegerFlag(args, "--lsp-memory-budget-bytes", process.env.LECTOR_LSP_MEMORY_BUDGET_BYTES);
	const reservedForegroundSlots = nonNegativeIntegerFlag(args, "--reserved-foreground-slots", process.env.LECTOR_RESERVED_FOREGROUND_SLOTS);
	const backgroundAdmissionQueueTimeoutMs = nonNegativeIntegerFlag(
		args,
		"--background-admission-queue-timeout-ms",
		process.env.LECTOR_BACKGROUND_ADMISSION_QUEUE_TIMEOUT_MS,
	);
	const maxQueuedBackgroundAdmissions = positiveIntegerFlag(args, "--max-queued-background-admissions", process.env.LECTOR_MAX_QUEUED_BACKGROUND_ADMISSIONS);
	const absoluteMaxActiveIndexes = positiveIntegerFlag(args, "--absolute-max-active-indexes", process.env.LECTOR_ABSOLUTE_MAX_ACTIVE_INDEXES);
	if (memoryIds.length === 0 && pathEntries.length === 0 && !dynamicWorkspaces) {
		fail("lector serve requires at least one --workspace <id>, --workspace-path <id>=<dir>, or --dynamic-workspaces");
	}

	const workspaces = new Map<WorkspaceId, WorkspacePort>();
	for (const id of memoryIds) workspaces.set(id, new InMemoryWorkspace());
	for (const { id, dir } of pathEntries) workspaces.set(id, new LocalFilesystemWorkspace(dir));

	const summary =
		[...memoryIds.map((id) => `${id} (in-memory)`), ...pathEntries.map(({ id, dir }) => `${id} (${dir})`)].join(", ") || "none pre-registered, dynamic-only";

	serveMain({
		workspaces,
		allowDynamicOnly: dynamicWorkspaces,
		symbolIndexMemoryBudgetBytes,
		reservedForegroundSlots,
		backgroundAdmissionQueueTimeoutMs,
		maxQueuedBackgroundAdmissions,
		absoluteMaxActiveIndexes,
		logger: createLogger("lector", { levelEnvVar: "LECTOR_LOG_LEVEL" }),
		onListen: ({ host, port }) => {
			console.error(`Lector listening on ${host}:${port} (workspaces: ${summary})`);
		},
	});
}

async function runJobStatus(jobId: string | undefined, flags: string[]): Promise<void> {
	if (!jobId) fail(USAGE);
	const client = await connectLectorClient();
	const { job } = await client.call("job.status", { jobId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(job) : formatJobSnapshot(job));
}

async function runJobWait(jobId: string | undefined, flags: string[]): Promise<void> {
	if (!jobId) fail(USAGE);
	const waitMsRaw = flagValue(flags, "--wait-ms");
	const waitMs = waitMsRaw === undefined ? 300_000 : Number(waitMsRaw);
	if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 300_000) fail("--wait-ms must be an integer from 1 to 300000");
	const client = await connectLectorClient();
	const initial = (await client.call("job.status", { jobId })).job;
	if (initial.status === "succeeded" || initial.status === "failed") {
		console.log(hasFlag(flags, "--json") ? JSON.stringify(initial) : formatJobSnapshot(initial));
		return;
	}
	const { topic } = await client.call("job.watch", { jobId });
	const initialTarget = resolveLectorDaemonConnection();
	let terminal: JobSnapshot<PopulateSymbolGraphResult> | undefined;
	let checking = false;
	let resolveDone!: () => void;
	let rejectDone!: (error: unknown) => void;
	const done = new Promise<void>((resolvePromise, rejectPromise) => {
		resolveDone = resolvePromise;
		rejectDone = rejectPromise;
	});
	const refresh = async (): Promise<void> => {
		if (checking || terminal) return;
		checking = true;
		try {
			const current = (await client.call("job.status", { jobId })).job;
			if (current.status === "succeeded" || current.status === "failed") {
				terminal = current;
				resolveDone();
			}
		} catch (error) {
			rejectDone(error);
		} finally {
			checking = false;
		}
	};
	const channel = connectPushChannel({
		url: () => {
			const target = resolveLectorDaemonConnection();
			return `ws://${target.host}:${target.port}/push`;
		},
		token: initialTarget.token,
		topics: [topic],
		onMessage: (receivedTopic) => {
			if (receivedTopic === topic) refresh().catch(rejectDone);
		},
	});
	const pollTimer = setInterval(() => {
		refresh().catch(rejectDone);
	}, 1_000);
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolvePromise) => {
		timeoutTimer = setTimeout(resolvePromise, waitMs);
	});
	try {
		await refresh();
		await Promise.race([done, timeout]);
	} finally {
		clearInterval(pollTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		channel.close();
	}
	const result = terminal ?? (await client.call("job.status", { jobId })).job;
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : formatJobSnapshot(result));
}

async function runPackageSource(projectDir: string | undefined, packageName: string | undefined, flags: string[]): Promise<void> {
	if (!projectDir || !packageName) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("package.resolveSource", {
		request: {
			projectRoot: resolve(projectDir),
			coordinate: {
				ecosystem: "npm",
				registry: flagValue(flags, "--registry") ?? null,
				name: packageName,
				requestedVersion: flagValue(flags, "--version") ?? null,
			},
		},
		bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS,
	});
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : formatPackageSourceResult(result));
}

async function runPackageListSources(flags: string[]): Promise<void> {
	const maxResults = requiredIntFlag(flags, "--max-results");
	const ecosystem = parseEcosystemFlag(flags);
	const text = flagValue(flags, "--query");
	const cursor = flagValue(flags, "--cursor");
	const client = await connectLectorClient();
	const page = await client.call("package.listSources", { maxResults, ecosystem, text, cursor });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(page));
		return;
	}
	if (page.entries.length === 0) {
		console.log("no resolved package sources");
		return;
	}
	for (const entry of page.entries) console.log(formatPackageSourceListEntry(entry));
	if (page.nextCursor) console.log(`--cursor ${page.nextCursor} for more`);
}

async function runPackageRemoveSource(
	ecosystem: string | undefined,
	name: string | undefined,
	resolvedVersion: string | undefined,
	flags: string[],
): Promise<void> {
	if (!name || !resolvedVersion) fail(USAGE);
	const validEcosystem = requireEcosystem(ecosystem);
	const registry = flagValue(flags, "--registry") ?? null;
	const client = await connectLectorClient();
	const result = await client.call("package.removeSource", { ecosystem: validEcosystem, registry, name, resolvedVersion });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(result.removed ? "removed" : "not recorded for that coordinate");
}

async function runPackageCleanSources(flags: string[]): Promise<void> {
	const ecosystem = parseEcosystemFlag(flags);
	const client = await connectLectorClient();
	const result = await client.call("package.cleanSources", { ecosystem });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `removed ${result.removed}, skipped ${result.skipped} (still in use)`);
}

async function runSearchSymbols(query: string | undefined, flags: string[]): Promise<void> {
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

async function runSearchText(query: string | undefined, flags: string[]): Promise<void> {
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

async function runSearchGithubRepos(query: string | undefined, flags: string[]): Promise<void> {
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

async function runSearchNpmPackages(query: string | undefined, flags: string[]): Promise<void> {
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

async function runSearchSourcegraphCode(query: string | undefined, flags: string[]): Promise<void> {
	if (!query) fail(USAGE);
	const maxResults = Number(flagValue(flags, "--max-results") ?? String(DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS));
	const client = await connectLectorClient();
	const { candidates } = await client.call("search.sourcegraphCode", { query, maxResults });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify({ candidates }));
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
}

export function lectorServiceSpec(): ServiceSpec {
	return {
		name: "lector",
		displayName: "Lector filesystem & code-intelligence service",
		version: lectorVersion(),
		binPath: process.execPath,
		args: [fileURLToPath(import.meta.url), "serve", "--dynamic-workspaces"],
		// The real {host,port,pid} handle file Armada uses for bounded readiness checks --
		// distinct from the old serviceDescriptor path (a systemd-unit-generation location,
		// now obsolete: Armada generates/manages the platform descriptor itself).
		handlePath: resolveLectorPaths().handle,
		restartOnFailure: true,
		restartSec: 2,
	};
}

export function lectorServiceCli() {
	return createServiceCli(lectorServiceSpec());
}

function runService(action: string | undefined): void {
	const service = lectorServiceCli();
	if (action === "install") {
		const result = service.install();
		if (!result.installed) fail(`failed to install the Lector service: ${result.reason}`);
		return;
	}
	if (action === "start" || action === "stop" || action === "restart" || action === "status") {
		service.action(action);
		return;
	}
	fail(USAGE);
}

type ActionHandler = (actionArgs: string[]) => Promise<void>;

const SEARCH_ACTIONS: Record<string, (query: string | undefined, flags: string[]) => Promise<void>> = {
	symbols: runSearchSymbols,
	text: runSearchText,
	"github-repos": runSearchGithubRepos,
	"npm-packages": runSearchNpmPackages,
	"sourcegraph-code": runSearchSourcegraphCode,
};

async function runSearch(rest: string[]): Promise<void> {
	const [action, query, ...searchFlags] = rest;
	const handler = action ? SEARCH_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(query, searchFlags);
}

const JOB_ACTIONS: Record<string, (jobId: string | undefined, flags: string[]) => Promise<void>> = {
	status: runJobStatus,
	wait: runJobWait,
};

async function runJob(rest: string[]): Promise<void> {
	const [action, jobId, ...jobFlags] = rest;
	const handler = action ? JOB_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(jobId, jobFlags);
}

const PACKAGE_ACTIONS: Record<string, ActionHandler> = {
	source: (actionRest) => {
		const [projectDir, packageName, ...packageFlags] = actionRest;
		return runPackageSource(projectDir, packageName, packageFlags);
	},
	"list-sources": (actionRest) => runPackageListSources(actionRest),
	"remove-source": (actionRest) => {
		const [ecosystem, name, resolvedVersion, ...removeFlags] = actionRest;
		return runPackageRemoveSource(ecosystem, name, resolvedVersion, removeFlags);
	},
	"clean-sources": (actionRest) => runPackageCleanSources(actionRest),
};

async function runPackage(rest: string[]): Promise<void> {
	const [action, ...actionRest] = rest;
	const handler = action ? PACKAGE_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(actionRest);
}

const TOP_LEVEL_COMMANDS: Record<string, (rest: string[]) => Promise<void>> = {
	serve: runServe,
	service: async (rest) => runService(rest[0]),
	search: runSearch,
	job: runJob,
	package: runPackage,
	workspace: runWorkspace,
};

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const handler = command ? TOP_LEVEL_COMMANDS[command] : undefined;
	if (!handler) fail(USAGE);
	return handler(rest);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
