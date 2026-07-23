import { runDaemonProcess, startDaemon, type RunningDaemon } from "@danypops/daemon-kit/daemon";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/daemon-kit/http";
import type { Logger } from "@danypops/daemon-kit/logging";
import { ensureAuthToken, type DaemonPaths } from "@danypops/daemon-kit/paths";
import { resolveLectorPaths } from "./constants.ts";
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

export interface LectorDaemonOptions {
	workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>;
	/** Override resolved paths (tests inject an isolated tmp root). Defaults to the real XDG paths. */
	paths?: DaemonPaths;
	logger?: Logger;
	/** Forwarded to createLectorService -- see its own doc comment. Still refuses zero workspaces by default. */
	allowDynamicOnly?: boolean;
}

function prepare(options: LectorDaemonOptions): {
	paths: DaemonPaths;
	app: { fetch(request: Request): Promise<Response> };
	onShutdown: () => Promise<void>;
} {
	const paths = options.paths ?? resolveLectorPaths();
	// createLectorService throws synchronously on an empty registry (unless allowDynamicOnly is
	// explicitly set), before startDaemon/runDaemonProcess ever binds a listener or writes a
	// handle file -- the daemon fails loudly at construction rather than starting and silently
	// returning empty/error results per call. (Locus LCS-BUG-88 class.)
	const service = createLectorService(options.workspaces, { allowDynamicOnly: options.allowDynamicOnly });
	const token = ensureAuthToken(paths.token, "Lector");
	// service.close() stops every warm symbol-index (LSP) subprocess the service spawned --
	// without this hook a daemon restart would leak one language server per workspace that
	// had ever run a symbol query.
	return { paths, app: buildLectorApp(service, token), onShutdown: () => service.close() };
}

/** In-process entry point: no signal wiring, returns a stoppable handle. Used by tests and embedders. */
export function startLectorDaemon(options: LectorDaemonOptions): RunningDaemon {
	const { paths, app, onShutdown } = prepare(options);
	return startDaemon({
		daemonLabel: "Lector",
		handlePath: paths.handle,
		buildApp: () => app,
		logger: options.logger,
		onShutdown,
	});
}

/** The real binary's entry point: wires SIGINT/SIGTERM and process.exit. */
export function serveMain(options: LectorDaemonOptions & { onListen?: (info: { host: string; port: number }) => void }): void {
	const { paths, app, onShutdown } = prepare(options);
	runDaemonProcess({
		daemonLabel: "Lector",
		handlePath: paths.handle,
		buildApp: () => app,
		logger: options.logger,
		onShutdown,
		onListen: options.onListen,
	});
}
