import { dirname, join } from "node:path";
import { type MaintenanceTask, type RunningDaemon, runDaemonProcess, startDaemon } from "@danypops/daemon-kit/daemon";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/daemon-kit/http";
import type { Logger } from "@danypops/daemon-kit/logging";
import { type DaemonPaths, ensureAuthToken } from "@danypops/daemon-kit/paths";
import { GitRepoFetcher } from "./adapters/git-repo-fetcher.ts";
import { InMemorySearchCache } from "./adapters/in-memory-search-cache.ts";
import { SqliteSearchCache } from "./adapters/sqlite-search-cache.ts";
import { SqliteSymbolGraph } from "./adapters/sqlite-symbol-graph.ts";
import { TieredSearchCache } from "./adapters/tiered-search-cache.ts";
import { resolveLectorPaths } from "./constants.ts";
import type { PackageSourceResolverPort } from "./ports/package-source-resolver-port.ts";
import type { RepoFetcherPort } from "./ports/repo-fetcher-port.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";
import { createLectorService, type LectorService, type OperationName, type WorkspaceId } from "./service.ts";
import { lectorVersion } from "./version.ts";

/** The Lector daemon's HTTP surface: Bearer-auth, health/ready, and the ops dispatch endpoint. */
export function buildLectorApp(service: LectorService, token: string): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (!requireBearerToken(request, token)) return errorResponse("unauthorized", 401);
			const url = new URL(request.url);

			if (request.method === "GET" && url.pathname === "/health") {
				return healthResponse(lectorVersion());
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				return readyResponse(true);
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return jsonResponse({ operations: service.operations });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				let body: { op?: unknown; input?: unknown };
				try {
					body = (await request.json()) as { op?: unknown; input?: unknown };
				} catch {
					return errorResponse("invalid JSON body", 400);
				}
				if (typeof body.op !== "string" || !service.operations.includes(body.op as OperationName)) {
					return errorResponse(`unknown operation: ${String(body.op)}`, 400);
				}
				if (typeof body.input !== "object" || body.input === null) {
					return errorResponse("input must be an object", 400);
				}
				try {
					const result = await service.dispatch(body.op as OperationName, body.input as never);
					return jsonResponse({ result });
				} catch (error) {
					// `toString()`, not `.message`: every Lector domain error sets a stable `.name`
					// (StaleExpectedHash, UnknownWorkspace, ...), and Error.prototype.toString()
					// renders it as "<name>: <message>". The RPC client's transport contract only
					// carries a single error string, so this is the seam that lets a caller on the
					// other side of HTTP distinguish error kinds without parsing message prose --
					// check `error.message.startsWith("SomeDomainError: ")`, not full-message matching.
					return errorResponse(error instanceof Error ? error.toString() : String(error), 400);
				}
			}
			return errorResponse("not found", 404);
		},
	};
}

/**
 * Idle-eviction TTL for warm symbol indexes (LSP subprocesses, mainly): a long-lived,
 * dynamic-workspace daemon accumulates one per project ever queried over its uptime, with
 * no natural point at which a project stops being relevant. 30 minutes matches Oculus's
 * own chosen value for the identical problem (gopls warm-pool TTL eviction) -- a real,
 * previously-shipped resource-growth fix, not an arbitrary number.
 */
const DEFAULT_SYMBOL_INDEX_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SYMBOL_INDEX_REAP_INTERVAL_MS = 5 * 60 * 1000;

export interface LectorDaemonOptions {
	workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>;
	/** Override resolved paths (tests inject an isolated tmp root). Defaults to the real XDG paths. */
	paths?: DaemonPaths;
	logger?: Logger;
	/** Forwarded to createLectorService -- see its own doc comment. Still refuses zero workspaces by default. */
	allowDynamicOnly?: boolean;
	/** Override the idle-eviction TTL for warm symbol indexes. Tests use a short value to observe eviction without waiting. */
	symbolIndexIdleTtlMs?: number;
	/** Override how often the idle-eviction sweep runs. */
	symbolIndexReapIntervalMs?: number;
	/** Override the repo.fetch backend (tests inject a GitRepoFetcher pointed at a local fixture repo, avoiding live network). Defaults to a real GitRepoFetcher under this daemon's own data directory. */
	createRepoFetcher?: () => RepoFetcherPort;
	/** Override package source resolution while retaining the authenticated daemon/client seam. */
	createPackageSourceResolver?: () => PackageSourceResolverPort;
}

function prepare(options: LectorDaemonOptions): {
	paths: DaemonPaths;
	app: { fetch(request: Request): Promise<Response> };
	onShutdown: () => Promise<void>;
	maintenanceTasks: MaintenanceTask[];
} {
	const paths = options.paths ?? resolveLectorPaths();
	// One SQLite file per workspace (named by its own deterministic workspaceId) under a
	// sibling directory of the main database -- not the same file, since SqliteSymbolGraph
	// and any other store sharing paths.database would collide on daemon-kit's single
	// PRAGMA user_version migration counter, silently skipping one store's own migrations.
	const symbolGraphDirectory = join(dirname(paths.database), "symbol-graphs");
	// One GitRepoFetcher for the whole daemon (not per-workspace, unlike symbol graphs) -- it
	// manages its own disk-bounded LRU cache of fetched external repos under a sibling
	// directory of the main database, independent of any single registered workspace.
	const reposDirectory = join(dirname(paths.database), "repos");
	// createLectorService throws synchronously on an empty registry (unless allowDynamicOnly is
	// explicitly set), before startDaemon/runDaemonProcess ever binds a listener or writes a
	// handle file -- the daemon fails loudly at construction rather than starting and silently
	// returning empty/error results per call. (Locus LCS-BUG-88 class.)
	const service = createLectorService(options.workspaces, {
		allowDynamicOnly: options.allowDynamicOnly,
		createSymbolGraph: (workspaceId) => new SqliteSymbolGraph(join(symbolGraphDirectory, `${workspaceId}.db`)),
		createRepoFetcher: options.createRepoFetcher ?? (() => new GitRepoFetcher(reposDirectory)),
		createPackageSourceResolver: options.createPackageSourceResolver,
		// The real production shape the SearchCachePort design was for: an in-memory tier for
		// speed plus a disk-backed tier so repeated searches survive a daemon restart -- a single
		// SearchCachePort adapter can only be one or the other, service.ts's own safe default is
		// in-memory-only.
		createSearchCache: () => new TieredSearchCache(new InMemorySearchCache(), new SqliteSearchCache(join(dirname(paths.database), "search-cache.db"))),
	});
	const token = ensureAuthToken(paths.token, "Lector");
	const idleTtlMs = options.symbolIndexIdleTtlMs ?? DEFAULT_SYMBOL_INDEX_IDLE_TTL_MS;
	// service.close() stops every warm symbol-index (LSP) subprocess the service spawned --
	// without this hook a daemon restart would leak one language server per workspace that
	// had ever run a symbol query. reapIdleSymbolIndexes (below) is the same idea on a timer,
	// for indexes that go idle long before the daemon itself ever restarts.
	return {
		paths,
		app: buildLectorApp(service, token),
		onShutdown: () => service.close(),
		maintenanceTasks: [
			{
				name: "reap-idle-symbol-indexes",
				intervalMs: options.symbolIndexReapIntervalMs ?? DEFAULT_SYMBOL_INDEX_REAP_INTERVAL_MS,
				run: async () => {
					await service.reapIdleSymbolIndexes(idleTtlMs);
				},
			},
		],
	};
}

/** In-process entry point: no signal wiring, returns a stoppable handle. Used by tests and embedders. */
export function startLectorDaemon(options: LectorDaemonOptions): RunningDaemon {
	const { paths, app, onShutdown, maintenanceTasks } = prepare(options);
	return startDaemon({
		daemonLabel: "Lector",
		handlePath: paths.handle,
		buildApp: () => app,
		logger: options.logger,
		onShutdown,
		maintenanceTasks,
	});
}

/** The real binary's entry point: wires SIGINT/SIGTERM and process.exit. */
export function serveMain(options: LectorDaemonOptions & { onListen?: (info: { host: string; port: number }) => void }): void {
	const { paths, app, onShutdown, maintenanceTasks } = prepare(options);
	runDaemonProcess({
		daemonLabel: "Lector",
		handlePath: paths.handle,
		buildApp: () => app,
		logger: options.logger,
		onShutdown,
		maintenanceTasks,
		onListen: options.onListen,
	});
}
