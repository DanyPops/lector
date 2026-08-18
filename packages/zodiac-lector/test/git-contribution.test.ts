import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@zodiac/protocol";
import { createLectorZodiacContribution, lectorOperationsFromClient } from "../src/index.js";
import { startIsolatedDaemon } from "./support/isolated-daemon.js";

type GitOpen = { commandId: string; input: { workspaceId: string; path: string; line: number; character: number } } | null;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd }).toString().trim();
}

function createRepository(): string {
	const root = mkdtempSync(join(tmpdir(), "zodiac-lector-git-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "alignment@example.test");
	git(root, "config", "user.name", "Zodiac Fixture");
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/math.ts"), "export function answer() {\n\treturn 41;\n}\n");
	writeFileSync(join(root, "rename-me.txt"), "rename\n");
	writeFileSync(join(root, "delete-me.txt"), "delete\n");
	writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "initial");
	return root;
}

function host() {
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

function command(commands: ReadonlyMap<string, ContributionCommand>, id: string): ContributionCommand {
	const found = commands.get(id);
	if (!found) throw new Error(`Missing command: ${id}`);
	return found;
}

function reference(outcome: Awaited<ReturnType<ContributionCommand["execute"]>>): ContributionResourceReference {
	if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
	return outcome.value;
}

async function read(
	provider: ContributionResourceProvider | undefined,
	resource: ContributionResourceReference,
	bounds = { maxBytes: 100_000, maxEntries: 100 },
): Promise<unknown> {
	if (!provider) throw new Error("Missing provider");
	const outcome = await provider.read(resource, bounds);
	if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
	return outcome.value;
}

describe("Lector Zodiac Git contribution", () => {
	const roots: string[] = [];
	let stop: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await stop?.();
		stop = undefined;
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("projects bounded status, log, diff and symbol comparison from a generated real repository", async () => {
		const root = createRepository();
		roots.push(root);
		const initial = git(root, "rev-parse", "HEAD");
		writeFileSync(join(root, "src/math.ts"), "export function answer() {\n\treturn 42;\n}\n");
		git(root, "add", "src/math.ts");
		git(root, "commit", "-q", "-m", "answer 42");
		writeFileSync(join(root, "src/math.ts"), "export function answer() {\n\treturn 43;\n}\n");
		writeFileSync(join(root, "untracked.txt"), "new\n");

		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		const registered = host();
		await createLectorZodiacContribution({ operations: lectorOperationsFromClient(daemon.client) }).activate(registered.api);
		const workspace = reference(await command(registered.commands, "lector.workspace.open").execute({ path: root }));
		const workspaceId = decodeURIComponent(new URL(workspace.uri).pathname.slice(1));

		const status = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.git.status").execute({ workspaceId, maxEntries: 20, maxBytes: 50_000 })),
		);
		expect(status).toMatchObject({ kind: "git-status", workspaceId, detached: false, truncated: false });
		const statusFiles = (status as { files: Array<{ path: string; state: string; open: { commandId: string } | null }> }).files;
		expect(statusFiles.find((file) => file.path === "src/math.ts")).toMatchObject({ state: "modified", open: { commandId: "lector.file.open" } });
		expect(statusFiles.find((file) => file.path === "untracked.txt")).toMatchObject({ state: "untracked" });

		const log = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.git.log").execute({ workspaceId, maxCount: 2, maxBytes: 50_000 })),
		);
		expect(log).toMatchObject({
			kind: "git-log",
			revisions: { head: expect.stringMatching(/^[0-9a-f]{40}$/) },
			entries: [expect.objectContaining({ message: "answer 42" }), expect.objectContaining({ message: "initial" })],
			truncated: false,
		});

		const diff = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.git.diff").execute({ workspaceId, ref: "HEAD", maxBytes: 50_000 })),
		);
		const diffFile = (diff as { files: Array<{ path: string; binary: boolean; hunks: Array<{ newStart: number; open: GitOpen }> }> }).files[0];
		const diffHunk = diffFile?.hunks[0];
		expect(diff).toMatchObject({ kind: "git-diff", revisions: { from: "HEAD", to: "working tree" }, truncated: false });
		expect(diffFile).toMatchObject({ path: "src/math.ts", binary: false });
		expect(diffHunk).toMatchObject({ newStart: 1, open: { commandId: "lector.file.open", input: { line: 1 } } });
		if (!diffHunk?.open) throw new Error("Missing openable diff hunk");
		const openedHunk = reference(await command(registered.commands, diffHunk.open.commandId).execute(diffHunk.open.input));
		expect(await read(registered.provider(), openedHunk)).toMatchObject({
			kind: "text",
			path: "src/math.ts",
			content: expect.stringContaining("return 43"),
		});

		const comparison = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.git.compare-symbol").execute({
					workspaceId,
					path: "src/math.ts",
					symbolName: "answer",
					fromRef: initial,
					maxBytes: 50_000,
				}),
			),
		);
		expect(comparison).toMatchObject({
			kind: "git-symbol-comparison",
			path: "src/math.ts",
			symbolName: "answer",
			status: "changed",
			revisions: { from: initial, to: "working tree" },
			truncated: false,
		});
		const comparisonHunks = (comparison as { hunks: Array<{ open: { commandId: string } | null }> }).hunks;
		expect(comparisonHunks[0]).toMatchObject({ open: { commandId: "lector.file.open" } });
	});

	it("types non-Git, bad-ref, detached, binary, renamed, deleted and truncated outcomes", async () => {
		const root = createRepository();
		roots.push(root);
		git(root, "checkout", "--detach", "-q");
		git(root, "mv", "rename-me.txt", "renamed.txt");
		rmSync(join(root, "delete-me.txt"));
		writeFileSync(join(root, "binary.bin"), Buffer.from([0, 9, 8, 7, 6]));

		const plain = mkdtempSync(join(tmpdir(), "zodiac-lector-not-git-"));
		roots.push(plain);
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		const registered = host();
		await createLectorZodiacContribution({ operations: lectorOperationsFromClient(daemon.client) }).activate(registered.api);
		const gitWorkspace = reference(await command(registered.commands, "lector.workspace.open").execute({ path: root }));
		const workspaceId = decodeURIComponent(new URL(gitWorkspace.uri).pathname.slice(1));
		const plainWorkspace = reference(await command(registered.commands, "lector.workspace.open").execute({ path: plain }));
		const plainId = decodeURIComponent(new URL(plainWorkspace.uri).pathname.slice(1));

		expect(await command(registered.commands, "lector.git.status").execute({ workspaceId: plainId, maxEntries: 10, maxBytes: 10_000 })).toMatchObject({
			ok: false,
			code: "not-git-repository",
		});
		expect(await command(registered.commands, "lector.git.diff").execute({ workspaceId, ref: "not-a-real-ref", maxBytes: 10_000 })).toMatchObject({
			ok: false,
			code: "bad-revision",
		});

		const status = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.git.status").execute({ workspaceId, maxEntries: 2, maxBytes: 50_000 })),
		);
		expect(status).toMatchObject({ kind: "git-status", detached: true, truncated: true, truncatedBy: ["entries"] });

		const fullStatusReference = reference(await command(registered.commands, "lector.git.status").execute({ workspaceId, maxEntries: 20, maxBytes: 50_000 }));
		const fullStatus = await read(registered.provider(), fullStatusReference);
		expect(await registered.provider()?.read(fullStatusReference, { maxBytes: 100_000, maxEntries: 1 })).toMatchObject({
			ok: false,
			code: "resource-bound-exceeded",
		});
		const fullStatusFiles = (fullStatus as { files: Array<{ path: string }> }).files;
		expect(fullStatusFiles.find((file) => file.path === "renamed.txt")).toMatchObject({ previousPath: "rename-me.txt", state: "renamed" });
		expect(fullStatusFiles.find((file) => file.path === "delete-me.txt")).toMatchObject({ state: "deleted", open: null });

		const binary = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.git.diff").execute({ workspaceId, maxBytes: 50_000 })),
		);
		const binaryFiles = (binary as { files: Array<{ path: string }> }).files;
		expect(binaryFiles.find((file) => file.path === "binary.bin")).toMatchObject({ binary: true, hunks: [] });

		const truncated = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.git.diff").execute({ workspaceId, maxBytes: 120 })),
		);
		expect(truncated).toMatchObject({ kind: "git-diff", truncated: true, truncatedBy: ["bytes"] });
	});
});
