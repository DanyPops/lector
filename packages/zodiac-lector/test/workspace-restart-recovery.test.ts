import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetryingLectorClient } from "@danypops/lector";
import type { ContributionCommand, ContributionResourceProvider } from "@zodiac/protocol";
import { createLectorZodiacContribution, lectorOperationsFromClient } from "../src/index.js";
import { startRestartableDaemon } from "./support/restartable-daemon.js";

function capturingHost() {
	const commands = new Map<string, ContributionCommand>();
	let provider: ContributionResourceProvider | undefined;
	return {
		commands,
		provider: () => provider,
		api: {
			registerCommand(command: ContributionCommand) {
				commands.set(command.id, command);
				return () => commands.delete(command.id);
			},
			registerResourceProvider(value: ContributionResourceProvider) {
				provider = value;
				return () => {
					provider = undefined;
				};
			},
		},
	};
}

function requireCommand(commands: ReadonlyMap<string, ContributionCommand>, id: string): ContributionCommand {
	const command = commands.get(id);
	if (!command) throw new Error(`Missing command: ${id}`);
	return command;
}

describe("Lector Zodiac contribution recovers from a real daemon restart", () => {
	let stop: (() => Promise<void>) | undefined;
	let workspaceRoot: string | undefined;

	afterEach(async () => {
		await stop?.();
		stop = undefined;
		if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
		workspaceRoot = undefined;
	});

	it("transparently recovers git status after the daemon restarts and forgets the workspaceId", async () => {
		const daemon = await startRestartableDaemon();
		stop = daemon.stop;
		workspaceRoot = mkdtempSync(join(tmpdir(), "zodiac-lector-restart-workspace-"));
		execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceRoot });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceRoot });
		writeFileSync(join(workspaceRoot, "a.ts"), "export const a = 1;\n");
		execFileSync("git", ["add", "."], { cwd: workspaceRoot });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: workspaceRoot });
		writeFileSync(join(workspaceRoot, "a.ts"), "export const a = 2;\n");

		// A client that rediscovers the daemon's own handle file on every reconnect, exactly like
		// authenticatedLectorOperations()'s real default -- unlike a client bound to one fixed
		// host:port, this can actually follow the daemon across a restart.
		const client = createRetryingLectorClient({ paths: daemon.paths });
		const operations = lectorOperationsFromClient({ call: (operation, input) => client.call(operation, input) });

		const host = capturingHost();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(host.api);

		const openWorkspace = requireCommand(host.commands, "lector.workspace.open");
		const gitStatus = requireCommand(host.commands, "lector.git.status");
		const provider = host.provider();
		if (!provider) throw new Error("Missing Lector resource provider");

		const opened = await openWorkspace.execute({ path: workspaceRoot });
		if (!opened.ok) throw new Error(`${opened.code}: ${opened.message}`);
		const workspaceId = decodeURIComponent(new URL(opened.value.uri).pathname.slice(1));

		const beforeOutcome = await gitStatus.execute({ workspaceId, maxEntries: 10, maxBytes: 4096 });
		if (!beforeOutcome.ok) throw new Error(`${beforeOutcome.code}: ${beforeOutcome.message}`);
		await expect(provider.read(beforeOutcome.value, { maxEntries: 10, maxBytes: 4096 })).resolves.toMatchObject({ ok: true, value: { kind: "git-status" } });

		await daemon.restart();

		// Without recovery this would surface `lector-error: UnknownWorkspace ...` -- the exact
		// failure mode observed live during Lector stress testing on 2026-08-09.
		const afterOutcome = await gitStatus.execute({ workspaceId, maxEntries: 10, maxBytes: 4096 });
		if (!afterOutcome.ok) throw new Error(`${afterOutcome.code}: ${afterOutcome.message}`);
		const read = await provider.read(afterOutcome.value, { maxEntries: 10, maxBytes: 4096 });
		if (!read.ok) throw new Error(`${read.code}: ${read.message}`);
		const value = read.value as { files: readonly { path: string }[] };
		expect(value.files.map((file) => file.path)).toContain("a.ts");
	});
});
