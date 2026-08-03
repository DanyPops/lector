/**
 * openDirectoryExplorer backs the /editor no-path Oil-style explorer: one resolved workspace for
 * the whole browsing session, plus create/rename/delete for both files and directories.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDirectoryExplorer } from "../../extension/src/editor/directory-explorer-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
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

function buildProjectFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-directory-explorer-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "index.ts"), "export {};\n");
	writeFileSync(join(root, "readme.md"), "hello\n");
	return root;
}

describe("openDirectoryExplorer", () => {
	it("lists the resolved root's own immediate children through a live daemon, excluding dotfiles by default", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		const listing = await session.listDirectory("");
		// buildProjectFixture also creates .git -- Oil's own default (view_options.show_hidden =
		// false) excludes it, and every other dotfile/dotdir, unless explicitly toggled.
		expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "readme.md"]);
	});

	it("lists a subdirectory by relative path within the same resolved workspace", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		const listing = await session.listDirectory("src");
		expect(listing.entries.map((entry) => entry.name)).toEqual(["index.ts"]);
	});

	it("createFile creates a real empty file on disk", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		await session.createFile("new-file.txt");
		expect(readFileSync(join(root, "new-file.txt"), "utf-8")).toBe("");
	});

	it("createDirectory creates a real directory on disk", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		await session.createDirectory("docs");
		expect(existsSync(join(root, "docs"))).toBe(true);
	});

	it("renamePath moves a real file on disk", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		await session.renamePath("readme.md", "README.md");
		expect(existsSync(join(root, "readme.md"))).toBe(false);
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("hello\n");
	});

	it("deleteFile removes a real file from disk, reading its current hash first", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		await session.deleteFile("readme.md");
		expect(existsSync(join(root, "readme.md"))).toBe(false);
	});

	it("deleteDirectory removes a real directory (and its contents) from disk", async () => {
		const root = buildProjectFixture();
		projectDir = root;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openDirectoryExplorer(root);
		await session.deleteDirectory("src");
		expect(existsSync(join(root, "src"))).toBe(false);
	});
});
