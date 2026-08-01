#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeServiceInstallDeps, installUserService, type ServiceSpec } from "@danypops/vehicle-server/service";
import { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "./adapters/local-filesystem-workspace.ts";
import { connectLectorClient, resolveLectorDaemonConnection } from "./client.ts";
import { LECTOR_PATH_NAMES, resolveLectorPaths } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import type { JobSnapshot } from "./domain/bounded-job-executor.ts";
import type { ContentHash } from "./domain/content-hash.ts";
import { DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS } from "./domain/external-search-result.ts";
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
  lector workspace watch <workspace-id> --pattern <glob> [--json]
    blocks, printing every real matching file change (created/modified/deleted) as it happens
    (Ctrl-C to stop) -- connects to the daemon's PushChannel over a real WebSocket, the same
    channel workspace.watch's own topic is delivered on for any other subscriber
  lector workspace unwatch <watch-id> [--json]
  lector workspace mutation-history <workspace-id> <path> --max-results <n> [--json]
    newest first -- every successful exactEdit/lineEdit/applyPatch/revertMutation on <path> is
    recorded, oldest entries evicted once the per-file bound is exceeded (not durable across a
    daemon restart)
  lector workspace revert-mutation <workspace-id> <entry-id> [--json]
    restores the file to its exact content immediately before that entry's own mutation --
    refuses if the file has changed since (a real, further-revertible mutation itself, not a
    special case: reverting a revert works)
  lector workspace apply-patch <workspace-id> <path> --patch <unified-diff-text> --expected-hash <hash> [--json]
    applies real unified-diff hunks (as diff -u / git diff produce), whole-file guarded --
    hunk context is searched for near its own line-number hint, tolerating a file that
    shifted slightly since the patch was generated, not trusted as an exact offset
  lector workspace line-edit <workspace-id> <path> --edits <json> [--json]
    --edits is a JSON array of LineEdit objects ({kind:"replace",startLine,endLine,
    expectedStartHash,expectedEndHash,lines} | {kind:"insertBefore"|"insertAfter",atLine,
    expectedHash,lines}) -- finer-grained than exactEdit's whole-file guard: a concurrent
    change to a line no edit references never invalidates this one. All edits in one call
    land atomically, or none do.
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
  lector workspace annotation list <workspace-id> [--subtype <s>] [--status <fresh|stale|scrubbed>] [--query <text>]
    [--max-results <n>] [--json]
  lector workspace annotation refresh <workspace-id> <annotation-id> --subtype <s> --title <t> --body <text>
    --anchor <path>:<line>:<character> (repeatable, at least one required) [--json]
  lector workspace annotation scrub <workspace-id> <annotation-id> [--json]
  lector workspace annotation restore <workspace-id> <annotation-id> [--json]
  lector workspace annotation contain <workspace-id> <parent-id> <child-id> [--json]
    idempotent -- containing an already-contained child is a no-op, not an error
  lector workspace annotation uncontain <workspace-id> <parent-id> <child-id> [--json]
    idempotent -- uncontaining an already-absent relationship is a no-op, not an error
  lector workspace annotation tree <workspace-id> <root-id> --max-depth <n> [--json]
    every annotation reachable via contains from root-id (including root-id itself), BFS-bounded
  lector workspace has-warm-index <workspace-id> [--json]
    never spawns a symbol index -- reports whether one is already warm
  lector workspace map <workspace-id> --max-nodes <n> --max-edges <n> --max-entries <n> --max-bytes <n> [--json]
    ranked, budget-bounded workspace summary (aider-repomap-shaped): the most structurally
    central symbols by PageRank over the populated graph, signature-only, highest-ranked first
  lector workspace cache-status <workspace-id> --max-files <n> --max-symbols-per-file <n> [--json]
  lector workspace reference-based-rename <workspace-id> <from-path> <to-path>
    --max-files <n> --max-symbols-per-file <n> [--json]
    non-LSP: rewrites every static import/export specifier this workspace's own populated symbol
    graph knows references the moved file, then physically moves it -- all atomically, rolled back
    on any failure. Refuses outright (touches nothing) unless the graph is fully "cached" (never
    "partial"/"not-cached") for these exact bounds. Does not follow dynamic import(expr)/
    require(expr) or any plain string reference -- see the returned caveats.
  lector workspace prepare-rename <workspace-id> <path> <line> <character> [--json]
    where/what could be renamed at this position -- null when nothing is renameable there
  lector workspace rename <workspace-id> <path> <line> <character> <new-name> [--json]
    LSP-driven: applies the negotiated server's own WorkspaceEdit atomically across every file it
    touches, validated against a fresh per-file hash snapshot taken immediately before applying
  lector workspace git-status <workspace-id> [--json]
  lector workspace git-log <workspace-id> --max-count <n> [--json]
  lector workspace git-diff <workspace-id> [--ref <ref>] --max-bytes <n> [--json]
  lector workspace compare-symbol <workspace-id> --path <p> --symbol <name> --from-ref <ref>
    [--to-ref <ref>] --max-bytes <n> [--json]
    tree-sitter syntactic tier only: a real unified diff of one symbol's own declaration text
    between two git refs, or a ref and the current working tree when --to-ref is omitted
  lector workspace repo-fetch <owner>/<repo>[@ref] [--host <host>] [--force-refresh] [--json]
    shallow-clones an external repo into a disk-bounded cache and registers it read-only;
    --force-refresh reclones even when an unexpired cache entry already exists (the "update"
    verb -- for a caller that has already positively confirmed the remote moved)
  lector workspace repo-cache-list --max-results <n> [--host <h>] [--owner <o>] [--repo <r>]
    [--ref <ref>] [--query <text>] [--cursor <c>] [--json]
    lists repo.fetch's own on-disk cache -- no network, no mutation -- filtered by any
    combination of host/owner/repo/ref (exact) and query (case-insensitive substring),
    bounded and paginated via --cursor
  lector workspace repo-cache-evict <owner>/<repo>[@ref] [--host <host>] [--json]
    removes one cached repo checkout from disk and the cache index; refuses if it is still a
    currently-registered workspace
  lector package source <project-dir> <package-name> [--version <exact-version>] [--registry <url>] [--json]
    resolves an installed npm package to verified exact repository source and registers it read-only
  lector workspace search-text <workspace-id> <query> --max-matches <n> --max-bytes <n> [--json]
  lector workspace find-files <workspace-id> --pattern <glob> (repeatable, at least one required)
    --max-results <n> --max-bytes <n> [--json]
    patterns are OR'd together -- a file matching any one of them is included
  lector search symbols <query> [--workspace <id>]... [--timeout-ms <n>] [--json]
  lector search text <query> --max-matches <n> --max-bytes <n> [--workspace <id>]... [--timeout-ms <n>] [--json]
  lector search github-repos <query> [--max-results <n>] [--json]
    finds real prior art before writing new code -- candidates are shaped as direct repo-fetch
    inputs (owner/repo/host); GITHUB_TOKEN raises the rate limit from 10 to 30 req/min
  lector search npm-packages <query> [--max-results <n>] [--json]
    candidates are shaped as direct package-source inputs (name, plus the version already returned)
  lector search sourcegraph-code <query> [--max-results <n>] [--json]
    content search across public GitHub via sourcegraph.com -- "which repos actually contain code
    matching X", not repo/package metadata search; each candidate's repository field feeds
    repo-fetch once split on "/"
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
	// Resolved here, against THIS process's own cwd -- the daemon is a long-running shared
	// service with no meaningful "current directory" relative to any particular caller, so it
	// rejects a relative path outright rather than guessing. The CLI is the one process that
	// actually knows what the invoking shell meant by "." or a bare relative directory name.
	const client = await connectLectorClient();
	const result = await client.call("workspace.registerPath", { path: resolve(dir) });
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

async function runWorkspaceReferenceBasedRename(
	workspaceId: string | undefined,
	fromPath: string | undefined,
	toPath: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !fromPath || !toPath) fail(USAGE);
	const maxFiles = requiredIntFlag(flags, "--max-files");
	const maxSymbolsPerFile = requiredIntFlag(flags, "--max-symbols-per-file");
	const client = await connectLectorClient();
	const outcome = await client.call("workspace.referenceBasedRename", { workspaceId, fromPath, toPath, maxFiles, maxSymbolsPerFile });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(outcome));
		return;
	}
	console.log(`moved to ${outcome.movedTo}`);
	if (outcome.filesUpdated.length === 0) console.log("no other files referenced it");
	else for (const path of outcome.filesUpdated) console.log(`updated import: ${path}`);
	for (const caveat of outcome.caveats) console.log(`caveat: ${caveat}`);
}

async function runWorkspacePrepareRename(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	const client = await connectLectorClient();
	const result = await client.call("workspace.prepareRename", { workspaceId, path, line, character });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	if (!result.range) {
		console.log("nothing renameable at this position");
		return;
	}
	if (!result.range.range) {
		console.log("renameable here (server left the exact range to the client)");
		return;
	}
	const { path: rangePath, start, end } = result.range.range;
	console.log(`renameable: ${rangePath}:${start.line}:${start.character}-${end.character}`);
}

async function runWorkspaceRename(workspaceId: string | undefined, path: string | undefined, rest: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const [lineArg, characterArg, newName, ...flags] = rest;
	const { line, character } = parsePosition(lineArg, characterArg);
	if (!newName) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.rename", { workspaceId, path, line, character, newName });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(formatIntelligenceSource(result.provenance));
	for (const touched of result.touchedPaths) console.log(`updated: ${touched}`);
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

async function runWorkspaceCompareSymbol(workspaceId: string | undefined, flags: string[]): Promise<void> {
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

async function runWorkspaceRepoCacheEvict(spec: string | undefined, flags: string[]): Promise<void> {
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

async function runWorkspaceRepoCacheList(flags: string[]): Promise<void> {
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

async function runWorkspaceFindFiles(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const patterns = collectFlagValues(flags, "--pattern");
	if (patterns.length === 0) fail("workspace find-files requires at least one --pattern");
	const maxResults = requiredIntFlag(flags, "--max-results");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.findFiles", { workspaceId, patterns, maxResults, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.paths.length === 0) {
		console.log(`no files match ${patterns.map((pattern) => `"${pattern}"`).join(", ")}`);
		return;
	}
	for (const path of result.paths) console.log(path);
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
	// A raw CLI flag; the daemon rejects an invalid value with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const status = statusFlag as "fresh" | "stale" | "scrubbed" | undefined;
	const maxResultsFlagValue = flagValue(flags, "--max-results");
	const maxResults = maxResultsFlagValue === undefined ? undefined : Number(maxResultsFlagValue);
	const query = flagValue(flags, "--query");
	const client = await connectLectorClient();
	const { annotations } = await client.call("workspace.listAnnotations", { workspaceId, subtype, status, maxResults, query });
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

async function runWorkspaceAnnotationContain(
	workspaceId: string | undefined,
	parentId: string | undefined,
	childId: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !parentId || !childId) fail(USAGE);
	const client = await connectLectorClient();
	const { contained } = await client.call("workspace.containAnnotation", { workspaceId, parentId, childId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ contained }) : `"${parentId}" now contains "${childId}"`);
}

async function runWorkspaceAnnotationUncontain(
	workspaceId: string | undefined,
	parentId: string | undefined,
	childId: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !parentId || !childId) fail(USAGE);
	const client = await connectLectorClient();
	const { uncontained } = await client.call("workspace.uncontainAnnotation", { workspaceId, parentId, childId });
	console.log(
		hasFlag(flags, "--json")
			? JSON.stringify({ uncontained })
			: uncontained
				? `"${parentId}" no longer contains "${childId}"`
				: `"${parentId}" did not contain "${childId}"`,
	);
}

async function runWorkspaceAnnotationTree(workspaceId: string | undefined, rootId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !rootId) fail(USAGE);
	const maxDepthFlagValue = flagValue(flags, "--max-depth");
	if (maxDepthFlagValue === undefined) fail(USAGE);
	const client = await connectLectorClient();
	const { annotations } = await client.call("workspace.annotationTree", { workspaceId, rootId, maxDepth: Number(maxDepthFlagValue) });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotations));
		return;
	}
	if (annotations.length === 0) {
		console.log(`no annotation "${rootId}"`);
		return;
	}
	for (const annotation of annotations) console.log(formatAnnotation(annotation));
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
	// A raw CLI flag; the daemon rejects an invalid hash with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const expectedHash = create ? null : (expectedHashFlag as ContentHash);

	const client = await connectLectorClient();
	const result = await client.call("workspace.exactEdit", { workspaceId, path, expectedHash, content });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}`);
}

async function runWorkspaceLineEdit(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const editsJson = flagValue(flags, "--edits");
	if (editsJson === undefined) fail("lector workspace line-edit requires --edits <json>");
	let edits: unknown;
	try {
		edits = JSON.parse(editsJson);
	} catch (error) {
		fail(`--edits is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(edits)) fail("--edits must be a JSON array of LineEdit objects");

	const client = await connectLectorClient();
	const result = await client.call("workspace.lineEdit", { workspaceId, path, edits });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash} -> ${result.newHash}`);
}

async function runWorkspaceWatch(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const pattern = flagValue(flags, "--pattern");
	if (!pattern) fail("lector workspace watch requires --pattern <glob>");
	const json = hasFlag(flags, "--json");

	const client = await connectLectorClient();
	const { watchId, topic } = await client.call("workspace.watch", { workspaceId, pattern });
	const { host, port, token } = resolveLectorDaemonConnection();
	if (!json) console.error(`watching "${pattern}" in workspace ${workspaceId} (watchId ${watchId}) -- Ctrl-C to stop`);

	const ws = new WebSocket(`ws://${host}:${port}/push?token=${token}`);
	await new Promise<void>((resolvePromise, reject) => {
		ws.addEventListener("open", () => resolvePromise());
		ws.addEventListener("error", () => reject(new Error("failed to connect to the daemon's push channel")));
	});
	ws.addEventListener("message", (event) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(event.data));
		} catch {
			return;
		}
		// Naming the two expected top-level keys while leaving their values as-is; every access
		// below already treats them as possibly absent.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const message = parsed as { topic?: string; payload?: { path?: string; kind?: string } };
		if (message.topic !== topic) return;
		if (json) {
			console.log(JSON.stringify(message.payload));
			return;
		}
		console.log(`${message.payload?.kind}\t${message.payload?.path}`);
	});
	ws.send(JSON.stringify({ op: "subscribe", topic }));

	// Blocks until Ctrl-C -- the real, intended shape of this command (`tail -f`, not a
	// request/response call), then cleans up its own registration rather than leaking a watch
	// (and the OS watcher it may be the last reference to) every time a caller stops watching.
	await new Promise<void>((resolvePromise) => {
		process.once("SIGINT", () => resolvePromise());
	});
	ws.close();
	await client.call("workspace.unwatch", { watchId }).catch(() => {});
}

async function runWorkspaceUnwatch(watchId: string | undefined, flags: string[]): Promise<void> {
	if (!watchId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.unwatch", { watchId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : result.unwatched ? "unwatched" : "no such watch (already removed or never existed)");
}

async function runWorkspaceApplyPatch(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const patchText = flagValue(flags, "--patch");
	if (patchText === undefined) fail("lector workspace apply-patch requires --patch <unified-diff-text>");
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (expectedHashFlag === undefined) fail("lector workspace apply-patch requires --expected-hash <hash>");
	// A raw CLI flag; the daemon rejects an invalid hash with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const expectedHash = expectedHashFlag as ContentHash;

	const client = await connectLectorClient();
	const result = await client.call("workspace.applyPatch", { workspaceId, path, expectedHash, patchText });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash} -> ${result.newHash}`);
}

async function runWorkspaceMutationHistory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
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

async function runWorkspaceRevertMutation(workspaceId: string | undefined, entryId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !entryId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.revertMutation", { workspaceId, entryId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path} reverted -> ${result.newHash ?? "(deleted)"}`);
}

/**
 * Login/boot persistence lifecycle (`install|start|stop|restart|status`) for a
 * persistent Lector daemon. `install` always runs `serve --dynamic-workspaces`:
 * a long-lived background daemon cannot know upfront which project(s) will
 * attach to it, so it starts with zero pre-registered workspaces and relies
 * entirely on workspace.registerPath at runtime.
 *
 * Unit generation and install/enable itself goes through vehicle-server's
 * shared installUserService -- restartOnFailure:true because Lector's own
 * client (client.ts) never auto-spawns, unlike connectWithPolicy's autoStart
 * consumers, so systemd's own supervision is this daemon's only recovery path.
 * start/stop/restart/status stay direct systemctl calls: Linux/systemd is the
 * only platform Lector's own lifecycle commands support today.
 */
export function lectorServiceSpec(): ServiceSpec {
	return {
		name: "lector",
		displayName: "Lector filesystem & code-intelligence service",
		binPath: process.execPath,
		args: [fileURLToPath(import.meta.url), "serve", "--dynamic-workspaces"],
		descriptorPath: resolveLectorPaths().serviceDescriptor,
		restartOnFailure: true,
		restartSec: 2,
	};
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function installService(): void {
	const result = installUserService(lectorServiceSpec(), createNodeServiceInstallDeps());
	if (!result.installed) fail(`failed to install the Lector service: ${result.reason}`);
	// installUserService's Linux path is `enable --now` (starts if not already running) --
	// an explicit restart on top ensures a re-install after a Lector upgrade actually picks
	// up the freshly-generated unit's new ExecStart path, not just re-enables the old one.
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
		if (action === "github-repos") return runSearchGithubRepos(query, searchFlags);
		if (action === "npm-packages") return runSearchNpmPackages(query, searchFlags);
		if (action === "sourcegraph-code") return runSearchSourcegraphCode(query, searchFlags);
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
		if (action === "line-edit") return runWorkspaceLineEdit(workspaceId, path, flags);
		if (action === "apply-patch") return runWorkspaceApplyPatch(workspaceId, path, flags);
		if (action === "mutation-history") return runWorkspaceMutationHistory(workspaceId, path, flags);
		if (action === "revert-mutation") return runWorkspaceRevertMutation(workspaceId, path, flags);
		if (action === "watch") return runWorkspaceWatch(workspaceId, actionArgs.slice(1));
		if (action === "unwatch") return runWorkspaceUnwatch(workspaceId, flags);
		if (action === "symbols") return runWorkspaceSymbols(workspaceId, path, flags);
		if (action === "search-text") return runWorkspaceSearchText(workspaceId, path, flags);
		if (action === "find-files") return runWorkspaceFindFiles(workspaceId, actionArgs.slice(1));
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
		if (action === "reference-based-rename") {
			const [rbrWorkspaceId, rbrFromPath, rbrToPath, ...rbrFlags] = actionArgs;
			return runWorkspaceReferenceBasedRename(rbrWorkspaceId, rbrFromPath, rbrToPath, rbrFlags);
		}
		if (action === "prepare-rename") {
			const [prWorkspaceId, prPath, ...prRest] = actionArgs;
			return runWorkspacePrepareRename(prWorkspaceId, prPath, prRest);
		}
		if (action === "rename") {
			const [renWorkspaceId, renPath, ...renRest] = actionArgs;
			return runWorkspaceRename(renWorkspaceId, renPath, renRest);
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
		if (action === "compare-symbol") {
			// Same reasoning as git-status/git-log/git-diff above -- --path is a flag here, not a positional.
			const [csWorkspaceId, ...csFlags] = actionArgs;
			return runWorkspaceCompareSymbol(csWorkspaceId, csFlags);
		}
		if (action === "repo-fetch") {
			const [spec, ...repoFlags] = actionArgs;
			return runWorkspaceRepoFetch(spec, repoFlags);
		}
		if (action === "repo-cache-list") return runWorkspaceRepoCacheList(actionArgs);
		if (action === "repo-cache-evict") {
			const [spec, ...evictFlags] = actionArgs;
			return runWorkspaceRepoCacheEvict(spec, evictFlags);
		}
		if (action === "annotation") {
			const [subcommand, annWorkspaceId, ...annRest] = actionArgs;
			if (subcommand === "create") return runWorkspaceAnnotationCreate(annWorkspaceId, annRest);
			if (subcommand === "list") return runWorkspaceAnnotationList(annWorkspaceId, annRest);
			if (subcommand === "contain" || subcommand === "uncontain") {
				const [parentId, childId, ...containFlags] = annRest;
				return subcommand === "contain"
					? runWorkspaceAnnotationContain(annWorkspaceId, parentId, childId, containFlags)
					: runWorkspaceAnnotationUncontain(annWorkspaceId, parentId, childId, containFlags);
			}
			const [annotationId, ...annFlags] = annRest;
			if (subcommand === "get") return runWorkspaceAnnotationGet(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "refresh") return runWorkspaceAnnotationRefresh(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "scrub") return runWorkspaceAnnotationScrub(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "restore") return runWorkspaceAnnotationRestore(annWorkspaceId, annotationId, annFlags);
			if (subcommand === "tree") return runWorkspaceAnnotationTree(annWorkspaceId, annotationId, annFlags);
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
