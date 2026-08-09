#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPushChannel } from "@danypops/vehicle-client/daemon-client";
import { createLogger } from "@danypops/vehicle-server/logging";
import { createServiceCli, type ServiceSpec } from "@danypops/vehicle-server/service";
import { connectLectorClient, resolveLectorDaemonConnection } from "./client.ts";
import type { JobSnapshot } from "./concurrency/bounded-job-executor.ts";
import { resolveLectorPaths } from "./constants.ts";
import type { ContentHash } from "./content-identity/content-hash.ts";
import { serveMain } from "./daemon.ts";
import { DEFAULT_EXTERNAL_SEARCH_MAX_RESULTS } from "./external-search/external-search-result.ts";
import {
	DEFAULT_PACKAGE_SOURCE_BOUNDS,
	PACKAGE_ECOSYSTEMS,
	type PackageEcosystem,
	type PackageSourceOperationResult,
} from "./package-source/package-source.ts";
import type { WorkspaceId } from "./service.ts";
import type { SymbolAnnotation } from "./symbol-annotation/symbol-annotation.ts";
import type { PopulateSymbolGraphResult } from "./symbol-graph/populate-symbol-graph.ts";
import { lectorVersion } from "./version.ts";
import { InMemoryWorkspace } from "./workspace/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "./workspace/local-filesystem-workspace.ts";
import type { WorkspacePort } from "./workspace/port.ts";
import type { ResponseFormat } from "./workspace/response-format.ts";
import type { SymbolSearchResult } from "./workspace/workspace-symbol.ts";

const USAGE = `Usage:
  lector serve [--workspace <id>]... [--workspace-path <id>=<dir>]... [--dynamic-workspaces]
    at least one --workspace, --workspace-path, or --dynamic-workspaces is required
    --workspace <id>            ephemeral in-memory workspace (data lost on restart)
    --workspace-path <id>=<dir> real directory <dir>, registered under <id>
    --dynamic-workspaces        start with none pre-registered; every workspace is added at
                                 runtime via "lector workspace register" (workspace.registerPath) --
                                 the mode a long-lived background daemon (e.g. lector.service) wants,
                                 since it does not know upfront which project(s) will attach to it
    --lsp-memory-budget-bytes <n> explicit adaptive budget for language-server process trees;
                                 otherwise a finite cgroup v2 memory.high is used when available
  lector service <install|start|stop|restart|status>
    install: writes a user systemd unit (lector serve --dynamic-workspaces), enables + starts it
  lector workspace register <dir> [--json]
  lector workspace read <workspace-id> <path> [--json]
  lector workspace edit <workspace-id> <path> --content <text> (--expected-hash <hash> | --create) [--json]
  lector workspace delete <workspace-id> <path> --expected-hash <hash> [--json]
    deletes one file entry, guarded by --expected-hash the same way edit's own guard works
  lector workspace list-directory <workspace-id> [path] [--json]
    immediate children only, not recursive -- omit [path] (or pass "") for the workspace root
  lector workspace create-directory <workspace-id> <path> [--json]
    mkdir -p semantics; a no-op if <path> already exists as a directory
  lector workspace rename-path <workspace-id> <old-path> <new-path> [--json]
    atomic move for a file or directory; rejects if <new-path> already exists
  lector workspace delete-directory <workspace-id> <path> [--json]
    recursive; NOT hash-guarded -- directories have no single content hash to guard with
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
  lector job wait <job-id> [--wait-ms <n>] [--json]
    waits up to 300000ms for PushChannel completion; status polling is the disconnect fallback
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
  lector package list-sources [--ecosystem <e>] [--query <text>] --max-results <n> [--cursor <c>] [--json]
    lists every package coordinate this daemon has already resolved to a verified source
    workspace -- no re-resolution, no network -- bounded and paginated via --cursor
  lector package remove-source <ecosystem> <name> <resolved-version> [--registry <url>] [--json]
    removes one resolved-source bookkeeping entry; refuses if it is still a currently-registered
    workspace. Does not delete the underlying repo.fetch disk cache entry -- use
    workspace repo-cache-evict for that, since a monorepo can share one checkout across
    several package coordinates
  lector package clean-sources [--ecosystem <e>] [--json]
    removes every non-in-use resolved-source entry, optionally scoped to one ecosystem;
    reports counts of removed and skipped (still-registered) entries
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

function positiveIntegerFlag(args: string[], flag: string, environmentValue?: string): number | undefined {
	const raw = flagValue(args, flag) ?? environmentValue;
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) fail(`${flag} must be a positive safe integer`);
	return value;
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
	const symbolIndexMemoryBudgetBytes = positiveIntegerFlag(args, "--lsp-memory-budget-bytes", process.env.LECTOR_LSP_MEMORY_BUDGET_BYTES);
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
		logger: createLogger("lector", { levelEnvVar: "LECTOR_LOG_LEVEL" }),
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
	if (job.status === "queued") return `${job.id}: queued (${job.operation}); wait with: lector job wait ${job.id}`;
	if (job.status === "running") return `${job.id}: still running (${job.operation}); wait with: lector job wait ${job.id}`;
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
	switch (outcome.status) {
		case "verified":
			return `${result.workspaceId ?? "unregistered"} ${outcome.coordinate.name}@${outcome.coordinate.resolvedVersion} -- ${outcome.workspace.cachePath}\n${outcome.repository.url ?? "local source"}@${outcome.repository.resolvedRef ?? "local"} ${outcome.repository.commit ?? outcome.verification.integrity}`;
		case "ambiguous":
			return `ambiguous [${outcome.code}] -- ${outcome.candidates.map((candidate) => `${candidate.version} (${candidate.source})`).join(", ")}${outcome.truncated ? ", …" : ""}`;
		case "unauthenticated":
			return `unauthenticated [${outcome.code}] -- configure ${outcome.requiredCredentialNames.join(", ")}`;
		case "oversized":
			return `oversized [${outcome.code}] -- ${outcome.resource} exceeded ${outcome.limit}`;
		case "mismatched":
			return `mismatched [${outcome.code}] -- expected ${outcome.expected}, got ${outcome.actual}`;
		case "unavailable":
			return `unavailable [${outcome.code}]`;
		default: {
			const exhaustive: never = outcome;
			throw new Error(`unhandled package source outcome status: ${JSON.stringify(exhaustive)}`);
		}
	}
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

// A real type guard, not an assertion -- widens the allowed-values array to readonly string[]
// so .includes() itself needs no cast, then lets TS narrow `value` for free at every call site.
function isPackageEcosystem(value: string): value is PackageEcosystem {
	return (PACKAGE_ECOSYSTEMS as readonly string[]).includes(value);
}

function parseEcosystemFlag(flags: string[]): PackageEcosystem | undefined {
	const raw = flagValue(flags, "--ecosystem");
	if (raw === undefined) return undefined;
	if (!isPackageEcosystem(raw)) fail(`--ecosystem must be one of ${PACKAGE_ECOSYSTEMS.join(", ")}; got "${raw}"`);
	return raw;
}

function requireEcosystem(value: string | undefined): PackageEcosystem {
	if (value === undefined || !isPackageEcosystem(value)) fail(`ecosystem must be one of ${PACKAGE_ECOSYSTEMS.join(", ")}; got "${value ?? ""}"`);
	return value;
}

function formatPackageSourceListEntry(entry: {
	name: string;
	resolvedVersion: string;
	workspaceId: string;
	cachePath: string;
	cacheSizeBytes: number | null;
}): string {
	const bytes = entry.cacheSizeBytes === null ? "" : ` (${entry.cacheSizeBytes} bytes)`;
	return `${entry.name}@${entry.resolvedVersion} -- ${entry.workspaceId} -- ${entry.cachePath}${bytes}`;
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

async function runWorkspaceDelete(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (expectedHashFlag === undefined) fail("lector workspace delete requires --expected-hash <hash>");
	// A raw CLI flag; the daemon rejects an invalid hash with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const expectedHash = expectedHashFlag as ContentHash;

	const client = await connectLectorClient();
	const result = await client.call("workspace.deleteEntry", { workspaceId, path, expectedHash });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `deleted "${result.path}" (was ${result.previousHash ?? "(absent)"})`);
}

async function runWorkspaceListDirectory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.listDirectory", { workspaceId, path: path ?? "" });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	for (const entry of result.entries) console.log(entry.kind === "directory" ? `${entry.name}/` : entry.name);
}

async function runWorkspaceCreateDirectory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.createDirectory", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `created directory "${result.path}"`);
}

async function runWorkspaceRenamePath(
	workspaceId: string | undefined,
	oldPath: string | undefined,
	newPath: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !oldPath || !newPath) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.renamePath", { workspaceId, oldPath, newPath });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `"${result.oldPath}" -> "${result.newPath}"`);
}

async function runWorkspaceDeleteDirectory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.deleteDirectory", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `deleted directory "${result.path}"`);
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
 * Native service installation and lifecycle actions go through vehicle-server's
 * shared Armada-backed service CLI. restartOnFailure:true because Lector's own
 * client (client.ts) never auto-spawns, unlike connectWithPolicy's autoStart
 * consumers, so native service supervision is this daemon's only recovery path.
 */
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

const WORKSPACE_ANNOTATION_ACTIONS: Record<string, (annWorkspaceId: string | undefined, annRest: string[]) => Promise<void>> = {
	create: runWorkspaceAnnotationCreate,
	list: runWorkspaceAnnotationList,
	contain: (annWorkspaceId, annRest) => {
		const [parentId, childId, ...containFlags] = annRest;
		return runWorkspaceAnnotationContain(annWorkspaceId, parentId, childId, containFlags);
	},
	uncontain: (annWorkspaceId, annRest) => {
		const [parentId, childId, ...containFlags] = annRest;
		return runWorkspaceAnnotationUncontain(annWorkspaceId, parentId, childId, containFlags);
	},
	get: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationGet(annWorkspaceId, annotationId, annFlags);
	},
	refresh: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationRefresh(annWorkspaceId, annotationId, annFlags);
	},
	scrub: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationScrub(annWorkspaceId, annotationId, annFlags);
	},
	restore: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationRestore(annWorkspaceId, annotationId, annFlags);
	},
	tree: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationTree(annWorkspaceId, annotationId, annFlags);
	},
};

async function runWorkspaceAnnotation(actionArgs: string[]): Promise<void> {
	const [subcommand, annWorkspaceId, ...annRest] = actionArgs;
	const handler = subcommand ? WORKSPACE_ANNOTATION_ACTIONS[subcommand] : undefined;
	if (!handler) fail(USAGE);
	return handler(annWorkspaceId, annRest);
}

// Every entry re-derives whatever slice of actionArgs it needs itself (rather than sharing one
// upfront [workspaceId, path, ...flags] destructure the way the old if-chain did) -- each action is
// independently addressable via WORKSPACE_ACTIONS[action], so nothing upstream is in scope to share.
const WORKSPACE_ACTIONS: Record<string, ActionHandler> = {
	register: (actionArgs) => {
		const [dir, ...flags] = actionArgs;
		return runWorkspaceRegister(dir, flags);
	},
	read: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceRead(workspaceId, path, flags);
	},
	edit: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceEdit(workspaceId, path, flags);
	},
	delete: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDelete(workspaceId, path, flags);
	},
	"list-directory": (actionArgs) => {
		// <path> is optional here (defaults to the workspace root) -- a generic
		// [workspaceId, path, ...flags] destructure would misparse a bare `--json` with no path
		// positional as path itself, the same flag-vs-positional bug git-status/compare-symbol below guard against.
		const [ldWorkspaceId, ...ldRest] = actionArgs;
		const ldPath = ldRest[0]?.startsWith("--") ? undefined : ldRest[0];
		const ldFlags = ldPath === undefined ? ldRest : ldRest.slice(1);
		return runWorkspaceListDirectory(ldWorkspaceId, ldPath, ldFlags);
	},
	"create-directory": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceCreateDirectory(workspaceId, path, flags);
	},
	"delete-directory": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDeleteDirectory(workspaceId, path, flags);
	},
	"rename-path": (actionArgs) => {
		// `path` here is really <old-path>; the generic [workspaceId, path, ...flags] destructure
		// still lines up correctly since rename-path's own second positional IS old-path.
		const [workspaceId, path, ...flags] = actionArgs;
		const [rpNewPath, ...rpFlags] = flags;
		return runWorkspaceRenamePath(workspaceId, path, rpNewPath, rpFlags);
	},
	"line-edit": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceLineEdit(workspaceId, path, flags);
	},
	"apply-patch": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceApplyPatch(workspaceId, path, flags);
	},
	"mutation-history": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceMutationHistory(workspaceId, path, flags);
	},
	"revert-mutation": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceRevertMutation(workspaceId, path, flags);
	},
	watch: (actionArgs) => {
		const [workspaceId] = actionArgs;
		return runWorkspaceWatch(workspaceId, actionArgs.slice(1));
	},
	unwatch: (actionArgs) => {
		const [workspaceId, , ...flags] = actionArgs;
		return runWorkspaceUnwatch(workspaceId, flags);
	},
	symbols: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceSymbols(workspaceId, path, flags);
	},
	"search-text": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceSearchText(workspaceId, path, flags);
	},
	"find-files": (actionArgs) => {
		const [workspaceId] = actionArgs;
		return runWorkspaceFindFiles(workspaceId, actionArgs.slice(1));
	},
	definition: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDefinition(workspaceId, path, flags);
	},
	implementation: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceImplementation(workspaceId, path, flags);
	},
	references: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceReferences(workspaceId, path, flags);
	},
	hover: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceHover(workspaceId, path, flags);
	},
	"document-symbols": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDocumentSymbols(workspaceId, path, flags);
	},
	diagnostics: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDiagnostics(workspaceId, path, flags);
	},
	"call-hierarchy": (actionArgs) => {
		const [subcommand, chWorkspaceId, chPath, ...chRest] = actionArgs;
		return runWorkspaceCallHierarchy(subcommand, chWorkspaceId, chPath, chRest);
	},
	"populate-symbol-graph": (actionArgs) => {
		const [psgWorkspaceId, ...psgFlags] = actionArgs;
		return runWorkspacePopulateSymbolGraph(psgWorkspaceId, psgFlags);
	},
	"symbol-graph": (actionArgs) => {
		const [subcommand, sgWorkspaceId, sgPath, ...sgRest] = actionArgs;
		return runWorkspaceSymbolGraphQuery(subcommand, sgWorkspaceId, sgPath, sgRest);
	},
	"has-warm-index": (actionArgs) => {
		const [hwiWorkspaceId, ...hwiFlags] = actionArgs;
		return runWorkspaceHasWarmIndex(hwiWorkspaceId, hwiFlags);
	},
	"cache-status": (actionArgs) => {
		const [cacheWorkspaceId, ...cacheFlags] = actionArgs;
		return runWorkspaceCacheStatus(cacheWorkspaceId, cacheFlags);
	},
	"reference-based-rename": (actionArgs) => {
		const [rbrWorkspaceId, rbrFromPath, rbrToPath, ...rbrFlags] = actionArgs;
		return runWorkspaceReferenceBasedRename(rbrWorkspaceId, rbrFromPath, rbrToPath, rbrFlags);
	},
	"prepare-rename": (actionArgs) => {
		const [prWorkspaceId, prPath, ...prRest] = actionArgs;
		return runWorkspacePrepareRename(prWorkspaceId, prPath, prRest);
	},
	rename: (actionArgs) => {
		const [renWorkspaceId, renPath, ...renRest] = actionArgs;
		return runWorkspaceRename(renWorkspaceId, renPath, renRest);
	},
	map: (actionArgs) => {
		const [mapWorkspaceId, ...mapFlags] = actionArgs;
		return runWorkspaceMap(mapWorkspaceId, mapFlags);
	},
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
	"repo-fetch": (actionArgs) => {
		const [spec, ...repoFlags] = actionArgs;
		return runWorkspaceRepoFetch(spec, repoFlags);
	},
	"repo-cache-list": (actionArgs) => runWorkspaceRepoCacheList(actionArgs),
	"repo-cache-evict": (actionArgs) => {
		const [spec, ...evictFlags] = actionArgs;
		return runWorkspaceRepoCacheEvict(spec, evictFlags);
	},
	annotation: (actionArgs) => runWorkspaceAnnotation(actionArgs),
};

async function runWorkspace(rest: string[]): Promise<void> {
	const [action, ...actionArgs] = rest;
	const handler = action ? WORKSPACE_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(actionArgs);
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
