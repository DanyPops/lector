#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "./adapters/local-filesystem-workspace.ts";
import { connectLectorClient } from "./client.ts";
import { LECTOR_PATH_NAMES } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import type { JobSnapshot } from "./domain/bounded-job-executor.ts";
import type { ContentHash } from "./domain/content-hash.ts";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS, type PackageSourceOperationResult } from "./domain/package-source.ts";
import type { PopulateSymbolGraphResult } from "./domain/populate-symbol-graph.ts";
import type { ResponseFormat } from "./domain/response-format.ts";
import type { SymbolAnnotation } from "./domain/symbol-annotation.ts";
import type { SymbolSearchResult } from "./domain/workspace-symbol.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";
import type { WorkspaceId } from "./service.ts";

const USAGE = `Usage:
  lector serve [--workspace <id>]... [--workspace-path <id>=<dir>]... [--dynamic-workspaces]
    at least one --workspace, --workspace-path, or --dynamic-workspaces is required
    --workspace <id>            ephemeral in-memory workspace (data lost on restart)
    --workspace-path <id>=<dir> real directory <dir>, registered under <id>
    --dynamic-workspaces        start with none pre-registered; every workspace is added at
                                 runtime via "lector workspace register" (workspace.registerPath) --
                                 the mode a long-lived background daemon (e.g. lector.service) wants,
                                 since it does not know upfront which project(s) will attach to it
  lector service <install|start|stop|restart|status>
    install: writes a user systemd unit (lector serve --dynamic-workspaces), enables + starts it
  lector workspace register <dir> [--json]
  lector workspace read <workspace-id> <path> [--json]
  lector workspace edit <workspace-id> <path> --content <text> (--expected-hash <hash> | --create) [--json]
  lector workspace symbols <workspace-id> <query> [--seed-file <path>] [--response-format <concise|detailed>] [--json]
  lector workspace definition <workspace-id> <path> <line> <character> [--json]
  lector workspace implementation <workspace-id> <path> <line> <character> [--json]
  lector workspace references <workspace-id> <path> <line> <character> [--include-declaration]
    [--response-format <concise|detailed>] [--json]
  lector workspace hover <workspace-id> <path> <line> <character> [--json]
  lector workspace document-symbols <workspace-id> <path> [--json]
  lector workspace diagnostics <workspace-id> <path> [--json]
  lector workspace call-hierarchy <prepare|incoming|outgoing> <workspace-id> <path> <line> <character> [--json]
  lector workspace populate-symbol-graph <workspace-id> --max-files <n> --max-symbols-per-file <n>
    [--background] [--wait-ms <n>] [--json]
    --background submits a bounded process-lifetime job; --wait-ms waits briefly for a fast result
  lector job status <job-id> [--json]
  lector workspace symbol-graph <reachable-from|edges-from|edges-to> <workspace-id> <path> <line> <character>
    [--max-depth <n>] [--kind <calls|references|contains>] [--json]
    --max-depth is required for reachable-from, ignored for edges-from/edges-to
  lector workspace annotation create <workspace-id> --subtype <s> --title <t> --body <text>
    --anchor <path>:<line>:<character> (repeatable, at least one required) [--json]
    each anchor must resolve to a real, currently-known symbol in the populated graph
  lector workspace annotation get <workspace-id> <annotation-id> [--json]
    live-checks staleness against the current graph/workspace before returning
  lector workspace annotation list <workspace-id> [--subtype <s>] [--status <fresh|stale|scrubbed>]
    [--max-results <n>] [--json]
  lector workspace annotation refresh <workspace-id> <annotation-id> --subtype <s> --title <t> --body <text>
    --anchor <path>:<line>:<character> (repeatable, at least one required) [--json]
  lector workspace annotation scrub <workspace-id> <annotation-id> [--json]
  lector workspace annotation restore <workspace-id> <annotation-id> [--json]
  lector workspace has-warm-index <workspace-id> [--json]
    never spawns a symbol index -- reports whether one is already warm
  lector workspace map <workspace-id> --max-nodes <n> --max-edges <n> --max-entries <n> --max-bytes <n> [--json]
    ranked, budget-bounded workspace summary (aider-repomap-shaped): the most structurally
    central symbols by PageRank over the populated graph, signature-only, highest-ranked first
  lector workspace cache-status <workspace-id> --max-files <n> --max-symbols-per-file <n> [--json]
  lector workspace git-status <workspace-id> [--json]
  lector workspace git-log <workspace-id> --max-count <n> [--json]
  lector workspace git-diff <workspace-id> [--ref <ref>] --max-bytes <n> [--json]
  lector workspace repo-fetch <owner>/<repo>[@ref] [--host <host>] [--json]
    shallow-clones an external repo into a disk-bounded cache and registers it read-only
  lector package source <project-dir> <package-name> [--version <exact-version>] [--registry <url>] [--json]
    resolves an installed npm package to verified exact repository source and registers it read-only
  lector workspace search-text <workspace-id> <query> --max-matches <n> --max-bytes <n> [--json]
  lector search symbols <query> [--workspace <id>]... [--timeout-ms <n>] [--json]
  lector search text <query> --max-matches <n> --max-bytes <n> [--workspace <id>]... [--timeout-ms <n>] [--json]
    fans out across the given --workspace id(s); with none given, every currently-registered
    workspace, daemon-wide -- this daemon is a shared service, so that default can include a
    project a different, concurrent Pi session registered. Prefer explicit --workspace when you
    mean "my own current projects".
    a workspace whose language server is still cold-starting is reported as "loading", not
    silently omitted and not blocking every other workspace's real results
`;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function collectFlagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === flag) {
			const value = args[index + 1];
			if (value === undefined) fail(`${flag} requires a value`);
			values.push(value);
			index++;
		}
	}
	return values;
}

function flagValue(args: string[], flag: string): string | undefined {
	return collectFlagValues(args, flag).at(-1);
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function parseWorkspacePathFlag(raw: string): { id: string; dir: string } {
	const separatorIndex = raw.indexOf("=");
	if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
		fail(`--workspace-path expects <id>=<dir>, got "${raw}"`);
	}
	return { id: raw.slice(0, separatorIndex), dir: raw.slice(separatorIndex + 1) };
}

async function runServe(args: string[]): Promise<void> {
	const memoryIds = collectFlagValues(args, "--workspace");
	const pathEntries = collectFlagValues(args, "--workspace-path").map(parseWorkspacePathFlag);
	const dynamicWorkspaces = hasFlag(args, "--dynamic-workspaces");
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
		onListen: ({ host, port }) => {
			console.error(`Lector listening on ${host}:${port} (workspaces: ${summary})`);
		},
	});
}

async function runWorkspaceRegister(dir: string | undefined, flags: string[]): Promise<void> {
	if (!dir) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.registerPath", { path: dir });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.workspaceId} (${result.created ? "created" : "already registered"})`);
}

function formatSymbolSources(result: SymbolSearchResult): readonly string[] {
	return (result.sources ?? []).map((source) => {
		const identity = `${source.provenance.languageId}: ${source.status} via ${source.provenance.backend}`;
		if (source.status === "failed") return source.error ? `${identity} [${source.error.code}] ${source.error.message}` : identity;
		return `${identity} (${source.symbolCount} symbol${source.symbolCount === 1 ? "" : "s"}${source.truncated ? ", truncated" : ""})`;
	});
}

function parseResponseFormat(flags: string[]): ResponseFormat | undefined {
	const value = flagValue(flags, "--response-format");
	if (value === undefined) return undefined;
	if (value !== "concise" && value !== "detailed") fail(`--response-format must be "concise" or "detailed", got "${value}"`);
	return value;
}

async function runWorkspaceSymbols(workspaceId: string | undefined, query: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !query) fail(USAGE);
	const seedFile = flagValue(flags, "--seed-file"); // omit to auto-discover one
	const responseFormat = parseResponseFormat(flags);
	const client = await connectLectorClient();
	const result = await client.call("workspace.findSymbols", { workspaceId, query, seedFile, responseFormat });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { symbols, provenance, truncated } = result;
	console.log(`${provenance.fidelity} via ${provenance.backend}${truncated ? " (truncated)" : ""}`);
	for (const source of formatSymbolSources(result)) console.log(source);
	if (symbols.length === 0) {
		console.log(`no symbols matched "${query}"`);
		return;
	}
	for (const symbol of symbols) {
		console.log(`${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`);
	}
}

function parsePosition(line: string | undefined, character: string | undefined): { line: number; character: number } {
	const parsedLine = Number(line);
	const parsedCharacter = Number(character);
	if (!line || !character || !Number.isInteger(parsedLine) || !Number.isInteger(parsedCharacter)) {
		fail(USAGE);
	}
	return { line: parsedLine, character: parsedCharacter };
}

function formatIntelligenceSource(provenance: { fidelity: string; backend: string }): string {
	return `${provenance.fidelity} via ${provenance.backend}`;
}

async function runWorkspaceDefinition(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.goToDefinition", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { locations, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (locations.length === 0) {
		console.log("no definition found");
		return;
	}
	for (const location of locations) console.log(`${location.path}:${location.line}:${location.character}`);
}

async function runWorkspaceImplementation(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.goToImplementation", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { locations, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (locations.length === 0) {
		console.log("no implementation found");
		return;
	}
	for (const location of locations) console.log(`${location.path}:${location.line}:${location.character}`);
}

async function runWorkspaceReferences(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const includeDeclaration = hasFlag(flags, "--include-declaration");
	const responseFormat = parseResponseFormat(flags);
	const client = await connectLectorClient();
	const result = await client.call("workspace.findReferences", { workspaceId, path, line, character, includeDeclaration, responseFormat });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { locations, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (locations.length === 0) {
		console.log("no references found");
		return;
	}
	for (const location of locations) console.log(`${location.path}:${location.line}:${location.character}`);
}

async function runWorkspaceHover(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.hover", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	console.log(result.hover ? result.hover.contents : "no hover information available");
}

async function runWorkspaceDocumentSymbols(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.documentSymbols", { workspaceId, path });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { symbols, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (symbols.length === 0) {
		console.log("no symbols found");
		return;
	}
	const printEntry = (entry: (typeof symbols)[number], depth: number): void => {
		console.log(`${"  ".repeat(depth)}${entry.kind} ${entry.name} -- ${entry.range.path}:${entry.range.start.line}:${entry.range.start.character}`);
		for (const child of entry.children ?? []) printEntry(child, depth + 1);
	};
	for (const entry of symbols) printEntry(entry, 0);
}

async function runWorkspaceDiagnostics(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.diagnostics", { workspaceId, path });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	const { diagnostics, provenance } = result;
	console.log(formatIntelligenceSource(provenance));
	if (diagnostics.length === 0) {
		console.log("no diagnostics");
		return;
	}
	for (const diagnostic of diagnostics) {
		console.log(
			`${diagnostic.severity} ${diagnostic.range.path}:${diagnostic.range.start.line}:${diagnostic.range.start.character} -- ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${diagnostic.code}` : ""})` : ""}`,
		);
	}
}

function formatCallHierarchyEntry(entry: { kind: string; name: string; location: { path: string; line: number; character: number } }): string {
	return `${entry.kind} ${entry.name} -- ${entry.location.path}:${entry.location.line}:${entry.location.character}`;
}

async function runWorkspaceCallHierarchy(
	subcommand: string | undefined,
	workspaceId: string | undefined,
	path: string | undefined,
	rest: string[],
): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();

	if (subcommand === "prepare") {
		const result = await client.call("workspace.prepareCallHierarchy", { workspaceId, path, line, character });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		const { items, provenance } = result;
		console.log(formatIntelligenceSource(provenance));
		if (items.length === 0) {
			console.log("no call-hierarchy root at this position");
			return;
		}
		for (const item of items) console.log(formatCallHierarchyEntry(item));
		return;
	}
	if (subcommand === "incoming") {
		const result = await client.call("workspace.incomingCalls", { workspaceId, path, line, character });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		const { calls, provenance } = result;
		console.log(formatIntelligenceSource(provenance));
		if (calls.length === 0) {
			console.log("no incoming calls found");
			return;
		}
		for (const call of calls) console.log(formatCallHierarchyEntry(call.from));
		return;
	}
	if (subcommand === "outgoing") {
		const result = await client.call("workspace.outgoingCalls", { workspaceId, path, line, character });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(result));
			return;
		}
		const { calls, provenance } = result;
		console.log(formatIntelligenceSource(provenance));
		if (calls.length === 0) {
			console.log("no outgoing calls found");
			return;
		}
		for (const call of calls) console.log(formatCallHierarchyEntry(call.to));
		return;
	}
	fail(USAGE);
}

function formatSymbolNode(node: { kind: string; name: string; location: { path: string; line: number; character: number } }): string {
	return `${node.kind} ${node.name} -- ${node.location.path}:${node.location.line}:${node.location.character}`;
}

function requiredIntFlag(flags: string[], flag: string): number {
	const raw = flagValue(flags, flag);
	const parsed = Number(raw);
	if (raw === undefined || !Number.isInteger(parsed)) fail(`${flag} <n> is required`);
	return parsed;
}

function formatPopulationResult(result: PopulateSymbolGraphResult): string {
	const counts = `${result.filesProcessed}/${result.filesAttempted} files, ${result.symbolsProcessed} symbols, ${result.nodesAdded} nodes, ${result.edgesAdded} edges`;
	if (result.completeness === "complete") return counts;
	const first = result.failures[0];
	const failure = first ? `; first failure: ${first.path} [${first.code} via ${first.provenance.backend}] ${first.message}` : "";
	return `partial -- ${counts}, ${result.filesFailed} failed files (${result.failureCount} failed operations)${failure}`;
}

function formatJobSnapshot(job: JobSnapshot<PopulateSymbolGraphResult>): string {
	if (job.status === "queued") return `${job.id}: queued (${job.operation}); poll with: lector job status ${job.id}`;
	if (job.status === "running") return `${job.id}: still running (${job.operation}); poll with: lector job status ${job.id}`;
	if (job.status === "failed") return `${job.id}: failed [${job.error.code}] -- ${job.error.message}`;
	return `${job.id}: succeeded -- ${formatPopulationResult(job.result)}`;
}

async function runWorkspacePopulateSymbolGraph(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxFiles = requiredIntFlag(flags, "--max-files");
	const maxSymbolsPerFile = requiredIntFlag(flags, "--max-symbols-per-file");
	const client = await connectLectorClient();
	if (hasFlag(flags, "--background")) {
		const waitMsRaw = flagValue(flags, "--wait-ms");
		const waitMs = waitMsRaw === undefined ? 0 : Number(waitMsRaw);
		const { job } = await client.call("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles, maxSymbolsPerFile },
			waitMs,
		});
		console.log(hasFlag(flags, "--json") ? JSON.stringify(job) : formatJobSnapshot(job));
		return;
	}
	const result = await client.call("workspace.populateSymbolGraph", { workspaceId, maxFiles, maxSymbolsPerFile });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : formatPopulationResult(result));
}

async function runJobStatus(jobId: string | undefined, flags: string[]): Promise<void> {
	if (!jobId) fail(USAGE);
	const client = await connectLectorClient();
	const { job } = await client.call("job.status", { jobId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(job) : formatJobSnapshot(job));
}

async function runWorkspaceCacheStatus(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxFiles = requiredIntFlag(flags, "--max-files");
	const maxSymbolsPerFile = requiredIntFlag(flags, "--max-symbols-per-file");
	const client = await connectLectorClient();
	const status = await client.call("workspace.cacheStatus", { workspaceId, maxFiles, maxSymbolsPerFile });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(status));
		return;
	}
	if (status.status === "not-cached") console.log(`not cached -- ${status.reason}`);
	else if (status.status === "caching") console.log(`caching -- job ${status.jobId}`);
	else if (status.status === "partial") console.log(`partially cached -- ${formatPopulationResult(status.generation.result)}`);
	else console.log(`cached -- completed ${new Date(status.generation.completedAt).toISOString()}`);
}

async function runWorkspaceMap(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const maxNodes = requiredIntFlag(flags, "--max-nodes");
	const maxEdges = requiredIntFlag(flags, "--max-edges");
	const maxEntries = requiredIntFlag(flags, "--max-entries");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.map", { workspaceId, maxNodes, maxEdges, maxEntries, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.entries.length === 0) {
		console.log("no ranked symbols (has the graph been populated for this workspace?)");
		return;
	}
	for (const entry of result.entries) {
		const signature = entry.signature ? ` -- ${entry.signature}` : "";
		console.log(`${entry.score.toFixed(4)}  ${entry.kind} ${entry.name}  ${entry.path}:${entry.line}:${entry.character}${signature}`);
	}
	if (result.truncated) console.log(`... truncated (${result.totalRanked} ranked total)`);
}

async function runWorkspaceHasWarmIndex(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const client = await connectLectorClient();
	const { warm } = await client.call("workspace.hasWarmIndex", { workspaceId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ warm }) : warm ? "warm" : "not warm");
}

async function runWorkspaceGitStatus(workspaceId: string | undefined, flags: string[]): Promise<void> {
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

async function runWorkspaceGitLog(workspaceId: string | undefined, flags: string[]): Promise<void> {
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

async function runWorkspaceGitDiff(workspaceId: string | undefined, flags: string[]): Promise<void> {
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

/** Parses "owner/repo[@ref]" into the explicit fields repo.fetch expects; --host overrides the "github.com" default. */
function parseRepoSpec(spec: string, host: string): { host: string; owner: string; repo: string; ref: string | null } {
	const [ownerRepo, ref] = spec.split("@");
	const [owner, repo] = (ownerRepo ?? "").split("/");
	if (!owner || !repo) fail(`repo spec must be "<owner>/<repo>[@ref]", got "${spec}"`);
	return { host, owner, repo, ref: ref ?? null };
}

async function runWorkspaceRepoFetch(spec: string | undefined, flags: string[]): Promise<void> {
	if (!spec) fail(USAGE);
	const host = flagValue(flags, "--host") ?? "github.com";
	const reference = parseRepoSpec(spec, host);
	const client = await connectLectorClient();
	const result = await client.call("repo.fetch", reference);
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(`${result.workspaceId} ${result.fromCache ? "(from cache)" : "(fetched)"} -- ${result.path}`);
	if (result.refFallbackOccurred) console.log(`note: requested ref not found, fell back to the default branch (resolved: ${result.resolvedRef})`);
}

function formatPackageSourceResult(result: PackageSourceOperationResult): string {
	const { outcome } = result;
	if (outcome.status === "verified") {
		return `${result.workspaceId ?? "unregistered"} ${outcome.coordinate.name}@${outcome.coordinate.resolvedVersion} -- ${outcome.workspace.cachePath}\n${outcome.repository.url ?? "local source"}@${outcome.repository.resolvedRef ?? "local"} ${outcome.repository.commit ?? outcome.verification.integrity}`;
	}
	if (outcome.status === "ambiguous") {
		return `ambiguous [${outcome.code}] -- ${outcome.candidates.map((candidate) => `${candidate.version} (${candidate.source})`).join(", ")}${outcome.truncated ? ", …" : ""}`;
	}
	if (outcome.status === "unauthenticated") return `unauthenticated [${outcome.code}] -- configure ${outcome.requiredCredentialNames.join(", ")}`;
	if (outcome.status === "oversized") return `oversized [${outcome.code}] -- ${outcome.resource} exceeded ${outcome.limit}`;
	if (outcome.status === "mismatched") return `mismatched [${outcome.code}] -- expected ${outcome.expected}, got ${outcome.actual}`;
	return `unavailable [${outcome.code}]`;
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

async function runWorkspaceSearchText(workspaceId: string | undefined, query: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !query) fail(USAGE);
	const maxMatches = requiredIntFlag(flags, "--max-matches");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.searchText", { workspaceId, query, maxMatches, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.matches.length === 0) {
		console.log(`no matches for "${query}"`);
		return;
	}
	for (const match of result.matches) console.log(`${match.path}:${match.lineNumber}: ${match.line.replace(/\n$/, "")}`);
	if (result.truncated) console.log("... (truncated)");
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

function parseSymbolEdgeKind(flags: string[]): "calls" | "references" | "contains" | undefined {
	const raw = flagValue(flags, "--kind");
	if (raw === undefined) return undefined;
	if (raw !== "calls" && raw !== "references" && raw !== "contains") fail(`--kind must be calls, references, or contains; got "${raw}"`);
	return raw;
}

async function runWorkspaceSymbolGraphQuery(
	subcommand: string | undefined,
	workspaceId: string | undefined,
	path: string | undefined,
	rest: string[],
): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const kind = parseSymbolEdgeKind(flags);
	const client = await connectLectorClient();

	if (subcommand === "reachable-from") {
		const maxDepth = requiredIntFlag(flags, "--max-depth");
		const { symbols } = await client.call("workspace.reachableFrom", { workspaceId, path, line, character, maxDepth, kind });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(symbols));
			return;
		}
		if (symbols.length === 0) {
			console.log("nothing reachable at this position (has the graph been populated for this workspace?)");
			return;
		}
		for (const symbol of symbols) console.log(formatSymbolNode(symbol));
		return;
	}
	if (subcommand === "edges-from" || subcommand === "edges-to") {
		const operation = subcommand === "edges-from" ? "workspace.symbolEdgesFrom" : "workspace.symbolEdgesTo";
		const { symbols } = await client.call(operation, { workspaceId, path, line, character, kind });
		if (hasFlag(flags, "--json")) {
			console.log(JSON.stringify(symbols));
			return;
		}
		if (symbols.length === 0) {
			console.log("no edges found (has the graph been populated for this workspace?)");
			return;
		}
		for (const symbol of symbols) console.log(formatSymbolNode(symbol));
		return;
	}
	fail(USAGE);
}

/** "<path>:<line>:<character>" -- split from the right so a path containing colons (e.g. a Windows drive letter) is never misparsed as part of the position. */
function parseAnchorFlag(value: string): { path: string; line: number; character: number } {
	const lastColon = value.lastIndexOf(":");
	const secondLastColon = lastColon === -1 ? -1 : value.lastIndexOf(":", lastColon - 1);
	const path = secondLastColon === -1 ? "" : value.slice(0, secondLastColon);
	const line = secondLastColon === -1 ? Number.NaN : Number(value.slice(secondLastColon + 1, lastColon));
	const character = lastColon === -1 ? Number.NaN : Number(value.slice(lastColon + 1));
	if (!path || !Number.isInteger(line) || !Number.isInteger(character)) fail(`invalid --anchor value "${value}"; expected <path>:<line>:<character>`);
	return { path, line, character };
}

function formatAnnotation(annotation: SymbolAnnotation): string {
	const anchorLines = annotation.anchors.map((anchor) => `  - ${anchor.symbolNodeId}`).join("\n");
	return `[${annotation.status}] ${annotation.title} (${annotation.subtype}) [${annotation.id}]\n${annotation.body}\nAnchors:\n${anchorLines}`;
}

function requireAnnotationFields(flags: string[]): {
	subtype: string;
	title: string;
	body: string;
	anchors: { path: string; line: number; character: number }[];
} {
	const subtype = flagValue(flags, "--subtype");
	const title = flagValue(flags, "--title");
	const body = flagValue(flags, "--body");
	if (!subtype || !title || body === undefined) fail("requires --subtype, --title, and --body");
	const anchors = collectFlagValues(flags, "--anchor").map(parseAnchorFlag);
	return { subtype, title, body, anchors };
}

async function runWorkspaceAnnotationCreate(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const { subtype, title, body, anchors } = requireAnnotationFields(flags);
	const client = await connectLectorClient();
	const { annotation } = await client.call("workspace.createAnnotation", { workspaceId, subtype, title, body, anchors });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(annotation) : formatAnnotation(annotation));
}

async function runWorkspaceAnnotationGet(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const client = await connectLectorClient();
	const { annotation } = await client.call("workspace.getAnnotation", { workspaceId, id });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotation ?? null));
		return;
	}
	console.log(annotation ? formatAnnotation(annotation) : `no annotation "${id}" in workspace "${workspaceId}"`);
}

async function runWorkspaceAnnotationList(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const subtype = flagValue(flags, "--subtype");
	const statusFlag = flagValue(flags, "--status");
	const status = statusFlag as "fresh" | "stale" | "scrubbed" | undefined;
	const maxResultsFlagValue = flagValue(flags, "--max-results");
	const maxResults = maxResultsFlagValue === undefined ? undefined : Number(maxResultsFlagValue);
	const client = await connectLectorClient();
	const { annotations } = await client.call("workspace.listAnnotations", { workspaceId, subtype, status, maxResults });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotations));
		return;
	}
	if (annotations.length === 0) {
		console.log("no annotations");
		return;
	}
	for (const annotation of annotations) console.log(formatAnnotation(annotation));
}

async function runWorkspaceAnnotationRefresh(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const { subtype, title, body, anchors } = requireAnnotationFields(flags);
	const client = await connectLectorClient();
	const { annotation } = await client.call("workspace.refreshAnnotation", { workspaceId, id, subtype, title, body, anchors });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotation ?? null));
		return;
	}
	console.log(annotation ? formatAnnotation(annotation) : `no annotation "${id}" in workspace "${workspaceId}"`);
}

async function runWorkspaceAnnotationScrub(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const client = await connectLectorClient();
	const { scrubbed } = await client.call("workspace.scrubAnnotation", { workspaceId, id });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ scrubbed }) : scrubbed ? `scrubbed ${id}` : `"${id}" was already scrubbed or does not exist`);
}

async function runWorkspaceAnnotationRestore(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const client = await connectLectorClient();
	const { restored } = await client.call("workspace.restoreAnnotation", { workspaceId, id });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ restored }) : restored ? `restored "${id}"` : `"${id}" was not scrubbed or does not exist`);
}

async function runWorkspaceRead(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.rawRead", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path} [${result.hash}]\n${result.content}`);
}

async function runWorkspaceEdit(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const content = flagValue(flags, "--content");
	if (content === undefined) fail("lector workspace edit requires --content <text>");

	const create = hasFlag(flags, "--create");
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (create === (expectedHashFlag !== undefined)) {
		fail("lector workspace edit requires exactly one of --create or --expected-hash <hash>");
	}
	const expectedHash = create ? null : (expectedHashFlag as ContentHash);

	const client = await connectLectorClient();
	const result = await client.call("workspace.exactEdit", { workspaceId, path, expectedHash, content });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}`);
}

/**
 * systemd user-unit lifecycle (`install|start|stop|restart|status`) for a
 * persistent Lector daemon. `install` always runs `serve
 * --dynamic-workspaces`: a long-lived background daemon cannot know
 * upfront which project(s) will attach to it, so it starts with zero
 * pre-registered workspaces and relies entirely on workspace.registerPath
 * at runtime.
 */
export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return `[Unit]
Description=Lector filesystem & code-intelligence service
After=default.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve --dynamic-workspaces
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function unitPath(): string {
	const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(configHome, "systemd", "user", LECTOR_PATH_NAMES.systemdUnitName);
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function installService(): void {
	const path = unitPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderSystemdUnit({ bunBin: process.execPath, cliPath: fileURLToPath(import.meta.url) }));
	systemctl("daemon-reload");
	systemctl("enable", LECTOR_PATH_NAMES.systemdUnitName);
	systemctl("restart", LECTOR_PATH_NAMES.systemdUnitName);
}

function runService(action: string | undefined): void {
	switch (action) {
		case "install":
			installService();
			return;
		case "start":
			systemctl("start", LECTOR_PATH_NAMES.systemdUnitName);
			return;
		case "stop":
			systemctl("stop", LECTOR_PATH_NAMES.systemdUnitName);
			return;
		case "restart":
			systemctl("restart", LECTOR_PATH_NAMES.systemdUnitName);
			return;
		case "status":
			systemctl("status", LECTOR_PATH_NAMES.systemdUnitName);
			return;
		default:
			fail(USAGE);
	}
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);

	if (command === "serve") return runServe(rest);
	if (command === "service") return runService(rest[0]);

	if (command === "search") {
		const [action, query, ...searchFlags] = rest;
		if (action === "symbols") return runSearchSymbols(query, searchFlags);
		if (action === "text") return runSearchText(query, searchFlags);
		fail(USAGE);
	}

	if (command === "job") {
		const [action, jobId, ...jobFlags] = rest;
		if (action === "status") return runJobStatus(jobId, jobFlags);
		fail(USAGE);
	}

	if (command === "package") {
		const [action, projectDir, packageName, ...packageFlags] = rest;
		if (action === "source") return runPackageSource(projectDir, packageName, packageFlags);
		fail(USAGE);
	}

	if (command === "workspace") {
		const [action, ...actionArgs] = rest;
		if (action === "register") {
			const [dir, ...flags] = actionArgs;
			return runWorkspaceRegister(dir, flags);
		}
		const [workspaceId, path, ...flags] = actionArgs;
		if (action === "read") return runWorkspaceRead(workspaceId, path, flags);
		if (action === "edit") return runWorkspaceEdit(workspaceId, path, flags);
		if (action === "symbols") return runWorkspaceSymbols(workspaceId, path, flags);
		if (action === "search-text") return runWorkspaceSearchText(workspaceId, path, flags);
		if (action === "definition") return runWorkspaceDefinition(workspaceId, path, flags);
		if (action === "implementation") return runWorkspaceImplementation(workspaceId, path, flags);
		if (action === "references") return runWorkspaceReferences(workspaceId, path, flags);
		if (action === "hover") return runWorkspaceHover(workspaceId, path, flags);
		if (action === "document-symbols") return runWorkspaceDocumentSymbols(workspaceId, path, flags);
		if (action === "diagnostics") return runWorkspaceDiagnostics(workspaceId, path, flags);
		if (action === "call-hierarchy") {
			const [subcommand, chWorkspaceId, chPath, ...chRest] = actionArgs;
			return runWorkspaceCallHierarchy(subcommand, chWorkspaceId, chPath, chRest);
		}
		if (action === "populate-symbol-graph") {
			const [psgWorkspaceId, ...psgFlags] = actionArgs;
			return runWorkspacePopulateSymbolGraph(psgWorkspaceId, psgFlags);
		}
		if (action === "symbol-graph") {
			const [subcommand, sgWorkspaceId, sgPath, ...sgRest] = actionArgs;
			return runWorkspaceSymbolGraphQuery(subcommand, sgWorkspaceId, sgPath, sgRest);
		}
		if (action === "has-warm-index") {
			const [hwiWorkspaceId, ...hwiFlags] = actionArgs;
			return runWorkspaceHasWarmIndex(hwiWorkspaceId, hwiFlags);
		}
		if (action === "cache-status") {
			const [cacheWorkspaceId, ...cacheFlags] = actionArgs;
			return runWorkspaceCacheStatus(cacheWorkspaceId, cacheFlags);
		}
		if (action === "map") {
			const [mapWorkspaceId, ...mapFlags] = actionArgs;
			return runWorkspaceMap(mapWorkspaceId, mapFlags);
		}
		if (action === "git-status" || action === "git-log" || action === "git-diff") {
			// None of these take a <path> positional -- the generic [workspaceId, path, ...flags]
			// destructure above would misparse the first flag as path (the exact bug
			// populate-symbol-graph's own CLI wiring hit).
			const [gitWorkspaceId, ...gitFlags] = actionArgs;
			if (action === "git-status") return runWorkspaceGitStatus(gitWorkspaceId, gitFlags);
			if (action === "git-log") return runWorkspaceGitLog(gitWorkspaceId, gitFlags);
			return runWorkspaceGitDiff(gitWorkspaceId, gitFlags);
		}
		if (action === "repo-fetch") {
			const [spec, ...repoFlags] = actionArgs;
			return runWorkspaceRepoFetch(spec, repoFlags);
		}
		if (action === "annotation") {
			const [subcommand, annWorkspaceId, ...annRest] = actionArgs;
			if (subcommand === "create") return runWorkspaceAnnotationCreate(annWorkspaceId, annRest);
			if (subcommand === "list") return runWorkspaceAnnotationList(annWorkspaceId, annRest);
			const [annotationId, ...annFlags] = annRest;
			if (subcommand === "get") return runWorkspaceAnnotationGet(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "refresh") return runWorkspaceAnnotationRefresh(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "scrub") return runWorkspaceAnnotationScrub(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "restore") return runWorkspaceAnnotationRestore(annWorkspaceId, annotationId, annFlags);
			fail(USAGE);
		}
		fail(USAGE);
	}

	fail(USAGE);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
