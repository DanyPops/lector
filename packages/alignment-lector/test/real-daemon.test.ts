import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@alignment/surface-protocol";
import { createLectorAlignmentContribution, lectorOperationsFromClient } from "../src/index.js";
import { startIsolatedDaemon } from "./support/isolated-daemon.js";

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

function requireProvider(provider: ContributionResourceProvider | undefined): ContributionResourceProvider {
	if (!provider) throw new Error("Missing Lector resource provider");
	return provider;
}

function resourceValue(outcome: Awaited<ReturnType<ContributionCommand["execute"]>>): ContributionResourceReference {
	if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
	return outcome.value;
}

describe("Lector Alignment contribution against a real daemon", () => {
	let stop: (() => Promise<void>) | undefined;
	let workspaceRoot: string | undefined;

	afterEach(async () => {
		await stop?.();
		stop = undefined;
		if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
		workspaceRoot = undefined;
	});

	it("opens explicit workspace/tree/text resources and fails closed at read bounds", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		workspaceRoot = mkdtempSync(join(tmpdir(), "alignment-lector-workspace-"));
		mkdirSync(join(workspaceRoot, "src"));
		writeFileSync(join(workspaceRoot, "src", "a.ts"), "hello");
		writeFileSync(join(workspaceRoot, "README.md"), "readme");

		const host = capturingHost();
		const contribution = createLectorAlignmentContribution({ operations: lectorOperationsFromClient(daemon.client) });
		await contribution.activate(host.api);

		const workspace = resourceValue(await requireCommand(host.commands, "lector.workspace.open").execute({ path: workspaceRoot }));
		expect(workspace).toMatchObject({ kind: "workspace", readOnly: true });
		const provider = requireProvider(host.provider());
		expect(await provider.read(workspace, { maxBytes: 100, maxEntries: 1 })).toMatchObject({ ok: false, code: "resource-bound-exceeded" });
		expect(await provider.read(workspace, { maxBytes: 100, maxEntries: 10 })).toMatchObject({
			ok: true,
			value: {
				kind: "tree",
				path: "",
				readOnly: true,
				entries: [
					{ name: "src", kind: "directory", resource: { kind: "workspace", readOnly: true } },
					{ name: "README.md", kind: "file", resource: { kind: "text", readOnly: true } },
				],
			},
		});

		const workspaceId = decodeURIComponent(new URL(workspace.uri).pathname.slice(1));
		const file = resourceValue(await requireCommand(host.commands, "lector.file.open").execute({ workspaceId, path: "src/a.ts" }));
		expect(file).toMatchObject({ kind: "text", readOnly: true });
		expect(await provider.read(file, { maxBytes: 4, maxEntries: 10 })).toMatchObject({ ok: false, code: "resource-bound-exceeded" });
		expect(await provider.read(file, { maxBytes: 5, maxEntries: 10 })).toEqual({
			ok: true,
			value: { kind: "text", workspaceId, path: "src/a.ts", content: "hello", hash: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 5, readOnly: true },
		});
		expect([...host.commands.keys()]).not.toContain("lector.file.write");
	});

	it("preserves explicit workspace identity instead of guessing another root", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		const host = capturingHost();
		const contribution = createLectorAlignmentContribution({ operations: lectorOperationsFromClient(daemon.client) });
		await contribution.activate(host.api);
		expect(await requireCommand(host.commands, "lector.file.open").execute({ workspaceId: "not-registered", path: "a.ts" })).toMatchObject({
			ok: false,
			code: "lector-error",
		});
	});
});
