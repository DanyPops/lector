/**
 * remoteErrorIs is the seam host adapters use to recognize a Lector domain
 * error that crossed HTTP, where `instanceof` doesn't survive transport.
 * Proven end to end here: a real StaleExpectedHash raised by the daemon,
 * received by a real client, is recognized by name on the other side.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { remoteErrorIs } from "../src/client.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/service.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

describe("remoteErrorIs", () => {
	it("recognizes a StaleExpectedHash raised by the daemon and received over HTTP", async () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const daemon = await startLectorDaemon({ workspaces: new Map([["main", new InMemoryWorkspace()]]), paths });
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};
		const token = readFileSync(paths.token, "utf8").trim();
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});
		await client.call("workspace.exactEdit", { workspaceId: "main", path: "a.txt", expectedHash: null, content: "hello" });

		let caught: unknown;
		try {
			await client.call("workspace.exactEdit", {
				workspaceId: "main",
				path: "a.txt",
				expectedHash: null, // wrong on purpose -- the file now exists
				content: "overwrite attempt",
			});
		} catch (error) {
			caught = error;
		}

		expect(remoteErrorIs(caught, "StaleExpectedHash")).toBe(true);
	});

	it("does not match a different error name", async () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const daemon = await startLectorDaemon({ workspaces: new Map([["main", new InMemoryWorkspace()]]), paths });
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};
		const token = readFileSync(paths.token, "utf8").trim();
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});

		let caught: unknown;
		try {
			await client.call("workspace.rawRead", { workspaceId: "does-not-exist", path: "a.txt" });
		} catch (error) {
			caught = error;
		}

		expect(remoteErrorIs(caught, "UnknownWorkspace")).toBe(true);
		expect(remoteErrorIs(caught, "StaleExpectedHash")).toBe(false);
	});

	it("returns false for a plain, unnamed error", () => {
		expect(remoteErrorIs(new Error("boom"), "StaleExpectedHash")).toBe(false);
		expect(remoteErrorIs("not even an error", "StaleExpectedHash")).toBe(false);
	});
});
