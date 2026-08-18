import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@zodiac/protocol";
import { createLectorZodiacContribution, GuardedLiveBuffer, lectorOperationsFromClient } from "../src/index.js";
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

describe("Lector Zodiac contribution against a real daemon", () => {
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
		workspaceRoot = mkdtempSync(join(tmpdir(), "zodiac-lector-workspace-"));
		mkdirSync(join(workspaceRoot, "src"));
		writeFileSync(join(workspaceRoot, "src", "a.ts"), "hello");
		writeFileSync(join(workspaceRoot, "README.md"), "readme");

		const host = capturingHost();
		const contribution = createLectorZodiacContribution({ operations: lectorOperationsFromClient(daemon.client) });
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
		expect(await provider.read(file, { maxBytes: 5, maxEntries: 10 })).toMatchObject({
			ok: true,
			value: {
				kind: "text",
				workspaceId,
				path: "src/a.ts",
				content: "hello",
				hash: expect.stringMatching(/^[0-9a-f]{64}$/),
				bytes: 5,
				dirty: false,
				editor: expect.any(GuardedLiveBuffer),
				readOnly: true,
			},
		});
		expect([...host.commands.keys()]).not.toContain("lector.file.write");
	});

	it("preserves local edits when a real external write makes guarded save stale", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		workspaceRoot = mkdtempSync(join(tmpdir(), "zodiac-lector-stale-"));
		writeFileSync(join(workspaceRoot, "note.txt"), "original");

		const host = capturingHost();
		const contribution = createLectorZodiacContribution({ operations: lectorOperationsFromClient(daemon.client) });
		await contribution.activate(host.api);
		const workspace = resourceValue(await requireCommand(host.commands, "lector.workspace.open").execute({ path: workspaceRoot }));
		const workspaceId = decodeURIComponent(new URL(workspace.uri).pathname.slice(1));
		const file = resourceValue(await requireCommand(host.commands, "lector.file.open").execute({ workspaceId, path: "note.txt" }));
		const projection = await requireProvider(host.provider()).read(file, { maxBytes: 100, maxEntries: 10 });
		if (!projection.ok || typeof projection.value !== "object" || projection.value === null || !("editor" in projection.value))
			throw new Error("Missing editor projection");
		const editor = projection.value.editor;
		expect(editor).toBeInstanceOf(GuardedLiveBuffer);
		if (!(editor instanceof GuardedLiveBuffer)) throw new Error("Invalid editor projection");
		editor.buffer.replace(0, editor.buffer.length, "local edit");
		expect(editor.dirty).toBe(true);
		writeFileSync(join(workspaceRoot, "note.txt"), "external edit");

		expect(await requireCommand(host.commands, "lector.file.save").execute({ resource: file })).toMatchObject({ ok: false, code: "stale-write" });
		expect(editor.stale?.actualHash).toMatch(/^[0-9a-f]{64}$/);
		expect(readFileSync(join(workspaceRoot, "note.txt"), "utf8")).toBe("external edit");
		expect(editor.buffer.text).toBe("local edit");
		expect(editor.dirty).toBe(true);
	});

	it("creates, renames, and deletes real files/directories on disk through the daemon", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		workspaceRoot = mkdtempSync(join(tmpdir(), "zodiac-lector-mutations-"));
		const root = workspaceRoot;

		const host = capturingHost();
		const contribution = createLectorZodiacContribution({ operations: lectorOperationsFromClient(daemon.client) });
		await contribution.activate(host.api);
		const workspace = resourceValue(await requireCommand(host.commands, "lector.workspace.open").execute({ path: root }));
		const workspaceId = decodeURIComponent(new URL(workspace.uri).pathname.slice(1));

		// createFile: a real, empty file lands on disk and is immediately editable.
		const created = resourceValue(await requireCommand(host.commands, "lector.file.create").execute({ workspaceId, path: "new.txt" }));
		expect(created).toMatchObject({ kind: "text", readOnly: true });
		expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("");

		// createDirectory: a real directory lands on disk.
		await requireCommand(host.commands, "lector.directory.create").execute({ workspaceId, path: "newdir" });
		expect(() => readFileSync(join(root, "newdir"))).toThrow(); // it's a directory, not a file

		// renamePath: the file moves for real.
		const renamed = resourceValue(
			await requireCommand(host.commands, "lector.path.rename").execute({ workspaceId, oldPath: "new.txt", newPath: "renamed.txt" }),
		);
		expect(renamed).toMatchObject({ kind: "text", readOnly: true });
		expect(readFileSync(join(root, "renamed.txt"), "utf8")).toBe("");

		// deleteFile: reads the real current hash first, then deletes for real.
		writeFileSync(join(root, "renamed.txt"), "content to delete");
		await requireCommand(host.commands, "lector.file.delete").execute({ workspaceId, path: "renamed.txt" });
		expect(() => readFileSync(join(root, "renamed.txt"))).toThrow();

		// deleteDirectory: removes the real directory (and its contents).
		writeFileSync(join(root, "newdir", "inner.txt"), "x");
		await requireCommand(host.commands, "lector.directory.delete").execute({ workspaceId, path: "newdir" });
		expect(() => readFileSync(join(root, "newdir", "inner.txt"))).toThrow();
	});

	it("preserves explicit workspace identity instead of guessing another root", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		const host = capturingHost();
		const contribution = createLectorZodiacContribution({ operations: lectorOperationsFromClient(daemon.client) });
		await contribution.activate(host.api);
		expect(await requireCommand(host.commands, "lector.file.open").execute({ workspaceId: "not-registered", path: "a.ts" })).toMatchObject({
			ok: false,
			code: "lector-error",
		});
	});
});
