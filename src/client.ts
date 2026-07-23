import { AuthenticatedRpcClient } from "@danypops/daemon-kit/rpc-client";
import { readDaemonHandle, type DaemonPaths } from "@danypops/daemon-kit/paths";
import { readFileSync } from "node:fs";
import { resolveLectorPaths } from "./constants.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";

export type LectorClient = AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

export interface ConnectLectorClientOptions {
	/** Override resolved paths (tests inject an isolated tmp root). Defaults to the real XDG paths. */
	paths?: DaemonPaths;
}

/** Connect to a running Lector daemon, probing health before returning. */
export async function connectLectorClient(options: ConnectLectorClientOptions = {}): Promise<LectorClient> {
	const paths = options.paths ?? resolveLectorPaths();
	const handle = readDaemonHandle(paths.handle);
	if (!handle) throw new Error("Lector daemon is not running; start it with `lector serve`");

	let token: string;
	try {
		token = readFileSync(paths.token, "utf8").trim();
	} catch {
		throw new Error("Lector daemon token is unreadable; restart it with `lector serve`");
	}

	const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(
		`http://${handle.host}:${handle.port}`,
		token,
		{ label: "Lector" },
	);
	try {
		await client.health();
	} catch {
		throw new Error("Lector daemon state is stale or unreachable; restart it with `lector serve`");
	}
	return client;
}
