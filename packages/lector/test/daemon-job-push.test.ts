import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { connectLectorClientAt } from "../src/client.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { DocumentSymbolEntry } from "../src/domain/document-symbol.ts";
import type { ClosableSymbolIndex } from "../src/service.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";
import type { WorkspaceLocation } from "../src/workspace/workspace-symbol.ts";
import { symbolSearchResult, TEST_SEMANTIC_PROVENANCE } from "./support/intelligence-provenance.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class DelayedCodeIndex implements ClosableSymbolIndex {
	readonly provenance = TEST_SEMANTIC_PROVENANCE;
	constructor(private readonly documents: Promise<readonly DocumentSymbolEntry[]>) {}
	findSymbols() {
		return Promise.resolve(symbolSearchResult());
	}
	goToDefinition(_location: WorkspaceLocation): Promise<readonly WorkspaceLocation[]> {
		return Promise.resolve([]);
	}
	documentSymbols(): Promise<readonly DocumentSymbolEntry[]> {
		return this.documents;
	}
	outgoingCalls(): Promise<[]> {
		return Promise.resolve([]);
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

let daemon: RunningDaemon | undefined;
let projectRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	projectRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

describe("real daemon job completion over PushChannel", () => {
	it("delivers one terminal job snapshot to a real WebSocket subscriber", async () => {
		const documents = deferred<readonly DocumentSymbolEntry[]>();
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createSymbolIndex: () => new DelayedCodeIndex(documents.promise),
		});
		projectRoot = mkdtempSync(join(tmpdir(), "lector-daemon-job-push-"));
		writeFileSync(join(projectRoot, "index.ts"), "export const value = 1;\n");
		writeFileSync(join(projectRoot, "tsconfig.json"), "{}");

		const token = readFileSync(isolated.paths.token, "utf8").trim();
		const client = connectLectorClientAt(`http://${daemon.host}:${daemon.port}`, token);
		const { workspaceId } = await client.call("workspace.registerPath", { path: projectRoot });
		const { job } = await client.call("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 },
			waitMs: 0,
		});
		const { topic } = await client.call("job.watch", { jobId: job.id });

		const received: Array<{ topic?: string; payload?: { job?: { id?: string; status?: string } } }> = [];
		const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}/push?token=${token}`);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
		});
		ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
		ws.send(JSON.stringify({ op: "subscribe", topic }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await client.call("job.status", { jobId: job.id })).job.status).toBe("running");
		expect(received).toEqual([]);

		documents.resolve([]);
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 5_000;
			const check = () => {
				if (received.some((message) => message.topic === topic)) return resolve();
				if (Date.now() >= deadline) return reject(new Error(`timed out; received: ${JSON.stringify(received)}`));
				setTimeout(check, 10);
			};
			check();
		});

		ws.close();
		const message = received.find((entry) => entry.topic === topic);
		expect(message?.payload?.job).toMatchObject({ id: job.id, status: "succeeded" });
	}, 20_000);
});
