/**
 * Proves the actual gap this migration closes, not just that it typechecks: the "git" tool's
 * status/log/diff sub-actions now go through invokeVehicleOperation() (see vehicle-client.ts),
 * so the shared cross-Vehicle Activity Broker actually observes them -- something the prior bare
 * lectorClient().call() path could never produce, since it never touched
 * publishOperationActivity() at all. Same proof pattern already established for web-spider's
 * web_category migration (pi-web-spider's execute-contract.test.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { registerActivityBroker, unregisterActivityBroker } from "@danypops/vehicle-client-pi/activity-broker";
import lectorExtension from "../../extension/src/index.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { parseLectorPresentation } from "../../extension/src/presentation/presentation-contract.ts";
import { resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let repoRoot: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	unregisterActivityBroker();
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

describe("git tool (status/log/diff): real end-to-end Activity Broker proof", () => {
	it("fires vehicle.operation.started/completed for workspace.gitStatus through the actual registered 'git' tool", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));

		repoRoot = mkdtempSync(join(tmpdir(), "pi-lector-git-activity-broker-"));
		git(repoRoot, "init", "-q");
		git(repoRoot, "config", "user.email", "t@t.com");
		git(repoRoot, "config", "user.name", "t");
		writeFileSync(join(repoRoot, "a.txt"), "hello\n");
		git(repoRoot, "add", "a.txt");
		git(repoRoot, "commit", "-q", "-m", "initial commit");

		const events: Array<{ type: string; refs: Record<string, unknown> }> = [];
		registerActivityBroker({ publish: (event) => events.push(event as { type: string; refs: Record<string, unknown> }) });

		const h = createExtensionHarness(lectorExtension, { cwd: repoRoot });
		await h.boot();
		try {
			const result = (await h.invokeTool("git", { action: "status", directory: repoRoot })) as { details: unknown };
			const details = parseLectorPresentation(result.details, "git") as { summary?: unknown } | undefined;
			expect(details?.summary).toBeDefined();
		} finally {
			await h.shutdown();
		}

		const statusEvents = events.filter((e) => e.refs.operation === "workspace.gitStatus");
		expect(statusEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
	}, 20_000);

	it("runs grep-history through the registered git tool with every bound explicit", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));

		repoRoot = mkdtempSync(join(tmpdir(), "pi-lector-git-history-tool-"));
		git(repoRoot, "init", "-q", "--initial-branch=main");
		git(repoRoot, "config", "user.email", "t@t.com");
		git(repoRoot, "config", "user.name", "t");
		writeFileSync(join(repoRoot, "a.txt"), "historical needle\n");
		git(repoRoot, "add", "a.txt");
		git(repoRoot, "commit", "-q", "-m", "historical");
		writeFileSync(join(repoRoot, "a.txt"), "current value\n");
		git(repoRoot, "commit", "-qam", "current");

		const harness = createExtensionHarness(lectorExtension, { cwd: repoRoot });
		await harness.boot();
		try {
			const result = (await harness.invokeTool("git", {
				action: "grep-history",
				directory: repoRoot,
				pattern: "historical needle",
				commitOffset: 0,
				maxCommits: 20,
				maxMatches: 20,
				maxBytes: 20_000,
				deadlineMs: 5_000,
			})) as { details: unknown };
			const details = parseLectorPresentation(result.details, "git") as { historyGrep?: { matches: readonly { text: string }[] } } | undefined;
			expect(details?.historyGrep?.matches).toContainEqual(expect.objectContaining({ text: "historical needle" }));
		} finally {
			await harness.shutdown();
		}
	}, 20_000);
});
