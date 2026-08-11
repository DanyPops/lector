import { readFileSync } from "node:fs";
import {
	createRetryingClient,
	type DaemonInstanceIdentity,
	daemonInstanceIdentity,
	isLikelyStaleConnectionError,
} from "@danypops/vehicle-client/daemon-client";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { type DaemonPaths, readDaemonHandle } from "@danypops/vehicle-server/paths";
import { resolveLectorPaths } from "./constants.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export interface LectorClient {
	call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	operations(): Promise<OperationName[]>;
	ready(): Promise<boolean>;
	health(): Promise<{ ok: true; version: string }>;
}

export interface LectorDaemonUnavailableDetails {
	readonly code: "lector-daemon-unavailable";
	readonly operation: OperationName | "health" | "ready" | "operations";
	readonly requestId: string;
	readonly workspaceId: string | null;
	readonly daemonPid: number | null;
	readonly processState: "exited" | "alive-unreachable" | "unknown";
	readonly exitStatus: number | null;
	readonly signal: string | null;
	readonly causeName: string;
	readonly diagnosticCommand: "systemctl --user status lector.service && journalctl --user-unit lector.service -n 50 --no-pager";
	readonly recovery: "Restart Lector, re-register dynamic workspaces, then retry.";
}

export class LectorDaemonUnavailable extends Error {
	constructor(readonly details: LectorDaemonUnavailableDetails) {
		super(
			`Lector daemon unavailable during ${details.operation} (request ${details.requestId}${details.workspaceId ? `, workspace ${details.workspaceId}` : ""}, process ${details.processState}). ${details.recovery}`,
		);
		this.name = "LectorDaemonUnavailable";
	}
}

let requestSequence = 0;

function requestId(): string {
	requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
	return `lector-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function workspaceIdFrom(input: unknown): string | null {
	if (typeof input !== "object" || input === null || !("workspaceId" in input)) return null;
	const workspaceId = input.workspaceId;
	return typeof workspaceId === "string" ? workspaceId.slice(0, 128) : null;
}

interface DaemonDiagnosticsSource {
	readonly daemonPid: number | null;
	readonly lastExit?: () => { exitStatus: number | null; signal: string | null } | null;
}

class DiagnosticLectorClient implements LectorClient {
	constructor(
		private readonly client: AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>,
		private readonly diagnostics: DaemonDiagnosticsSource,
	) {}

	private unavailable(error: unknown, operation: LectorDaemonUnavailableDetails["operation"], id: string, workspaceId: string | null): never {
		if (error instanceof LectorDaemonUnavailable) throw error;
		if (!isLikelyStaleConnectionError(error)) throw error;
		const lastExit = this.diagnostics.lastExit?.() ?? null;
		const daemonPid = this.diagnostics.daemonPid;
		const processState = lastExit !== null || (daemonPid !== null && !isPidAlive(daemonPid)) ? "exited" : daemonPid === null ? "unknown" : "alive-unreachable";
		throw new LectorDaemonUnavailable({
			code: "lector-daemon-unavailable",
			operation,
			requestId: id,
			workspaceId,
			daemonPid,
			processState,
			exitStatus: lastExit?.exitStatus ?? null,
			signal: lastExit?.signal ?? null,
			causeName: error instanceof Error ? error.name || "Error" : "Error",
			diagnosticCommand: "systemctl --user status lector.service && journalctl --user-unit lector.service -n 50 --no-pager",
			recovery: "Restart Lector, re-register dynamic workspaces, then retry.",
		});
	}

	async call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
		const id = requestId();
		try {
			return await this.client.call(operation, input);
		} catch (error) {
			return this.unavailable(error, operation, id, workspaceIdFrom(input));
		}
	}

	async operations(): Promise<OperationName[]> {
		const id = requestId();
		try {
			return await this.client.operations();
		} catch (error) {
			return this.unavailable(error, "operations", id, null);
		}
	}

	async ready(): Promise<boolean> {
		const id = requestId();
		try {
			return await this.client.ready();
		} catch (error) {
			return this.unavailable(error, "ready", id, null);
		}
	}

	async health(): Promise<{ ok: true; version: string }> {
		const id = requestId();
		try {
			return await this.client.health();
		} catch (error) {
			return this.unavailable(error, "health", id, null);
		}
	}
}

export interface ConnectLectorClientOptions {
	/** Override resolved paths (tests inject an isolated tmp root). Defaults to the real XDG paths. */
	paths?: DaemonPaths;
}

/** host/port/token for a running Lector daemon, without connecting -- the one seam the CLI's own `workspace watch` command reuses to open a raw WebSocket to /push, the same values connectLectorClient resolves internally for its own HTTP client. */
export function resolveLectorDaemonConnection(options: ConnectLectorClientOptions = {}): { host: string; port: number; token: string } {
	const paths = options.paths ?? resolveLectorPaths();
	const handle = readDaemonHandle(paths.handle);
	if (!handle) throw new Error("Lector daemon is not running; start it with `lector serve`");

	let token: string;
	try {
		token = readFileSync(paths.token, "utf8").trim();
	} catch {
		throw new Error("Lector daemon token is unreadable; restart it with `lector serve`");
	}
	return { host: handle.host, port: handle.port, token };
}

/** Connect to a running Lector daemon, probing health before returning. */
export async function connectLectorClient(options: ConnectLectorClientOptions = {}): Promise<LectorClient> {
	const paths = options.paths ?? resolveLectorPaths();
	const handle = readDaemonHandle(paths.handle);
	const { host, port, token } = resolveLectorDaemonConnection({ paths });
	const client = new DiagnosticLectorClient(
		new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${host}:${port}`, token, { label: "Lector" }),
		{ daemonPid: handle?.pid ?? null },
	);
	await client.health();
	return client;
}

/**
 * Construct a LectorClient directly against a known host/port/token, without
 * going through paths/handle-file discovery. For callers (tests, host
 * adapters standing up their own isolated daemon) that already have a
 * RunningDaemon and its token in hand. Ensures every consumer of Lector's
 * client gets the exact same AuthenticatedRpcClient class instance Lector
 * itself depends on -- a second, independently-resolved copy of
 * @danypops/vehicle-client in a consumer's own node_modules would otherwise be a
 * structurally distinct (if identical-looking) type.
 */
export interface LectorRestartEvent {
	/** The daemon instance identity (`pid:port`, or "unresolved" when no handle file was readable) observed before this change. */
	readonly previousIdentity: string;
	/** The identity observed after this change -- always different from previousIdentity. */
	readonly currentIdentity: string;
}

export interface RetryingLectorClient {
	call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	/** Like call(), but never retries the operation itself after a failure -- only the underlying connection resets. Use for a mutating/non-idempotent operation. */
	callOnce<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
	/**
	 * Fires whenever the daemon's own process identity changes (a real restart, detected from its
	 * handle file's pid:port, re-read before every dispatch) -- never on the very first resolution.
	 * Lets a consumer clear any process-local registration (e.g. a workspaceId) it cached against
	 * the daemon instance that is now gone. Returns an unsubscribe function.
	 */
	onRestart(listener: (event: LectorRestartEvent) => void): () => void;
	/** Drops any cached connection and identity, forcing the next call to reconnect and re-resolve. */
	reset(): void;
}

function daemonIdentityFromHandle(paths: DaemonPaths): DaemonInstanceIdentity {
	const handle = readDaemonHandle(paths.handle);
	return daemonInstanceIdentity(handle ? `${handle.pid}:${handle.port}` : "unresolved");
}

/**
 * Shared retrying, identity-aware Lector client every consumer (pi-lector, alignment-lector, and
 * any future one) should build on rather than hand-rolling its own reconnect policy. A daemon
 * binds a fresh random port on every restart; a naively-cached client would keep calling a dead
 * port until something noticed. `@danypops/vehicle-client`'s createRetryingClient already solves
 * that generically (retry-once-on-stale-connection) and ships resolveIdentity/onIdentityChange
 * specifically so "consumers can clear process-local registrations" (its own doc comment) -- the
 * exact shape of this house's repeated real bug: a workspaceId (or any other server-assigned id)
 * cached against a daemon instance that has since restarted. onRestart surfaces that hook here so
 * every Lector consumer gets it for free instead of reinventing it per package.
 */
export function createRetryingLectorClient(options: ConnectLectorClientOptions = {}): RetryingLectorClient {
	const paths = options.paths ?? resolveLectorPaths();
	const listeners = new Set<(event: LectorRestartEvent) => void>();
	const retrying = createRetryingClient<LectorClient>(() => connectLectorClient({ paths }), {
		label: "Lector",
		isStaleConnectionError: (error) => error instanceof LectorDaemonUnavailable || isLikelyStaleConnectionError(error),
		resolveIdentity: () => daemonIdentityFromHandle(paths),
		onIdentityChange: (change) => {
			for (const listener of listeners) listener({ previousIdentity: change.previous, currentIdentity: change.current });
		},
	});
	return {
		call: (operation, input) => retrying.call((client) => client.call(operation, input)),
		callOnce: (operation, input) => retrying.callOnce((client) => client.call(operation, input)),
		onRestart(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		reset: () => retrying.reset(),
	};
}

export function connectLectorClientAt(
	baseUrl: string,
	token: string,
	options: { daemonPid?: number; lastExit?: () => { exitStatus: number | null; signal: string | null } | null } = {},
): LectorClient {
	return new DiagnosticLectorClient(new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(baseUrl, token, { label: "Lector" }), {
		daemonPid: options.daemonPid ?? null,
		lastExit: options.lastExit,
	});
}

/**
 * True when `error` is the client-side rejection of a call whose Lector
 * domain error was `name` (e.g. "StaleExpectedHash"). The RPC transport
 * carries only a single error string -- see daemon.ts's ops-endpoint catch
 * block -- so a domain error class does not survive `instanceof` across
 * HTTP; every Lector domain error's `.name` is rendered as a `"<name>: "`
 * prefix on that string instead, and this is the one place that convention
 * should be read back, so host adapters never hand-roll message parsing.
 */
export function remoteErrorIs(error: unknown, name: string): boolean {
	return error instanceof Error && error.message.startsWith(`${name}: `);
}
