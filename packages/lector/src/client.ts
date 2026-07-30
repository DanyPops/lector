import { readFileSync } from "node:fs";
import { type DaemonPaths, readDaemonHandle } from "@danypops/vehicle-server/paths";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { resolveLectorPaths } from "./constants.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export type LectorClient = AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

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
	const { host, port, token } = resolveLectorDaemonConnection(options);
	const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${host}:${port}`, token, {
		label: "Lector",
	});
	try {
		await client.health();
	} catch {
		throw new Error("Lector daemon state is stale or unreachable; restart it with `lector serve`");
	}
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
export function connectLectorClientAt(baseUrl: string, token: string): LectorClient {
	return new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(baseUrl, token, { label: "Lector" });
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
