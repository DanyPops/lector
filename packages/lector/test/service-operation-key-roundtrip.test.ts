/**
 * Checklist: "cache/dedup key round-trips to the same stored data" (task
 * f3cdc40f). Oculus's own LCS-BUG-78 shipped because a returned identifier
 * (CacheKey) didn't match what a subsequent lookup used, producing silent
 * nulls. Proven here through the real daemon over HTTP, not just in-process
 * function calls, since the identifier also has to survive JSON transport.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { type LectorDaemonOptions, startLectorDaemon } from "../src/daemon.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

async function bootDaemon(workspaces: LectorDaemonOptions["workspaces"]) {
	const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
	const daemon = await startLectorDaemon({ workspaces, paths });
	const token = readFileSync(paths.token, "utf8").trim();
	const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
		label: "Lector",
	});
	cleanup = () => {
		void daemon.stop();
		cleanupPaths();
	};
	return { daemon, client };
}

describe("operation identifiers round-trip through the real daemon", () => {
	it("a hash returned by exactEdit is exactly the hash rawRead returns afterward", async () => {
		const { client } = await bootDaemon(new Map([["main", new InMemoryWorkspace()]]));

		const edit = await client.call("workspace.exactEdit", {
			workspaceId: "main",
			path: "a.txt",
			expectedHash: null,
			content: "hello",
		});

		const read = await client.call("workspace.rawRead", { workspaceId: "main", path: "a.txt" });

		expect(read.hash).toBe(edit.newHash);
	});

	it("the hash returned by one edit is accepted as the expectedHash for the next edit on the same content", async () => {
		const { client } = await bootDaemon(new Map([["main", new InMemoryWorkspace()]]));

		const created = await client.call("workspace.exactEdit", {
			workspaceId: "main",
			path: "a.txt",
			expectedHash: null,
			content: "hello",
		});

		// If the returned hash didn't round-trip, this would be rejected as stale.
		const updated = await client.call("workspace.exactEdit", {
			workspaceId: "main",
			path: "a.txt",
			expectedHash: created.newHash,
			content: "hello, world",
		});

		expect(updated.previousHash).toBe(created.newHash);
	});
});
