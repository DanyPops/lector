/**
 * openEditorFile backs /editor's open/save round-trip: one hash-guarded read on open, then a
 * save() closure that must reject a genuinely concurrent external write (StaleExpectedHash) --
 * the exact behavior /editor's :w depends on, deliberately NOT the transparent-retry behavior
 * createLectorWriteOperations uses for pi's own unconditional-overwrite write tool.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteErrorIs } from "@danypops/lector";
import { openEditorFile } from "../../extension/src/editor/operations.ts";
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

function buildProjectFixture(): { root: string; filePath: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-editor-operations-"));
	mkdirSync(join(root, ".git"));
	const filePath = join(root, "greeting.ts");
	writeFileSync(filePath, "export function greet() {\n\treturn 'hi';\n}\n");
	return { root, filePath };
}

describe("openEditorFile", () => {
	it("reads the real file's current content through a live daemon", async () => {
		const { filePath } = buildProjectFixture();
		projectDir = filePath;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openEditorFile(filePath);
		expect(session.content).toBe("export function greet() {\n\treturn 'hi';\n}\n");
	});

	it("save() writes the new content back to the real file on disk", async () => {
		const { filePath } = buildProjectFixture();
		projectDir = filePath;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openEditorFile(filePath);
		await session.save("export function greet() {\n\treturn 'hello';\n}\n");

		expect(readFileSync(filePath, "utf-8")).toBe("export function greet() {\n\treturn 'hello';\n}\n");
	});

	it("a second save() after the first succeeds still works -- the tracked hash advances", async () => {
		const { filePath } = buildProjectFixture();
		projectDir = filePath;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openEditorFile(filePath);
		await session.save("first edit\n");
		await session.save("second edit\n");

		expect(readFileSync(filePath, "utf-8")).toBe("second edit\n");
	});

	it("save() rejects with StaleExpectedHash when the file changed on disk after open -- never silently overwrites a concurrent external edit", async () => {
		const { filePath } = buildProjectFixture();
		projectDir = filePath;
		const { client, stop } = await startIsolatedLectorDaemon();
		stopDaemon = stop;
		setLectorClientConnectorForTests(async () => client);

		const session = await openEditorFile(filePath);

		// A genuinely concurrent external change -- written directly to disk, bypassing Lector,
		// the same way a human editing the file in another terminal would.
		writeFileSync(filePath, "changed from outside the editor session\n");

		let caught: unknown;
		try {
			await session.save("the editor's own conflicting edit\n");
		} catch (error) {
			caught = error;
		}
		expect(remoteErrorIs(caught, "StaleExpectedHash")).toBe(true);

		// The external write must survive -- the editor's conflicting save must never have landed.
		expect(readFileSync(filePath, "utf-8")).toBe("changed from outside the editor session\n");
	});
});
