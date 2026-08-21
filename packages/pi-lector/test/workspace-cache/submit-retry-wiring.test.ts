/**
 * createWorkspaceCacheOperations().submit()'s own default retryTimeBudgetMs wiring -- distinct
 * from the fakes-based operations.test.ts (which never touches the real job.submit call shape).
 * A real, if minimal, isolated daemon proves the actual wire-level input this tool sends, not just
 * that a fake accepted whatever shape the test itself constructed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LectorClient, OperationInputs, OperationName } from "@danypops/lector";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createWorkspaceCacheOperations } from "../../extension/src/workspace-cache/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("createWorkspaceCacheOperations().submit() -- retryTimeBudgetMs default", () => {
	it("defaults retryTimeBudgetMs to 60000 -- absorbing a brief concurrent edit is this tool's whole point, unlike the raw daemon operation's own fail-fast default", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		const capturedInputs: OperationInputs["job.submit"][] = [];
		const capturingClient: LectorClient = {
			...daemon.client,
			call: (operation: OperationName, input: unknown) => {
				if (operation === "job.submit") capturedInputs.push(input as OperationInputs["job.submit"]);
				return daemon.client.call(operation, input as never);
			},
		} as LectorClient;
		setLectorClientConnectorForTests(() => Promise.resolve(capturingClient));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-cache-retry-wiring-"));
		writeFileSync(join(projectDir, "index.ts"), "export function answer() { return 42; }\n");

		const cache = createWorkspaceCacheOperations("session-a");
		await cache.submit(projectDir, 10, 10);

		expect(capturedInputs).toContainEqual(expect.objectContaining({ ownerId: "session-a", input: expect.objectContaining({ retryTimeBudgetMs: 60_000 }) }));
	});

	it("an explicit retryTimeBudgetMs overrides the tool's own default", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		const capturedInputs: OperationInputs["job.submit"][] = [];
		const capturingClient: LectorClient = {
			...daemon.client,
			call: (operation: OperationName, input: unknown) => {
				if (operation === "job.submit") capturedInputs.push(input as OperationInputs["job.submit"]);
				return daemon.client.call(operation, input as never);
			},
		} as LectorClient;
		setLectorClientConnectorForTests(() => Promise.resolve(capturingClient));

		projectDir = mkdtempSync(join(tmpdir(), "pi-lector-cache-retry-wiring-"));
		writeFileSync(join(projectDir, "index.ts"), "export function answer() { return 42; }\n");

		const cache = createWorkspaceCacheOperations();
		await cache.submit(projectDir, 10, 10, 0, 0);

		expect(capturedInputs).toContainEqual(
			expect.objectContaining({ input: expect.objectContaining({ maxFiles: 10, maxSymbolsPerFile: 10, retryTimeBudgetMs: 0 }) }),
		);
	});
});
