import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../src/client.js";
import { LectorFilesystemPort, StaleWorkspaceWrite } from "../src/filesystem-port.js";
import { resetWorkspaceRegistrationForTests } from "../src/workspace-registration.js";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.js";

describe("LectorFilesystemPort", () => {
	let stop: (() => Promise<void>) | undefined;
	let root: string | undefined;

	afterEach(async () => {
		resetLectorClientForTests();
		resetWorkspaceRegistrationForTests();
		await stop?.();
		stop = undefined;
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function port(): LectorFilesystemPort {
		const daemon = startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		stop = daemon.stop;
		root = mkdtempSync(join(tmpdir(), "alef-lector-fs-test-"));
		return new LectorFilesystemPort(root);
	}

	it("reports version 1", () => {
		expect(port().version).toBe(1);
	});

	it("a path that was never written does not exist", async () => {
		const entry = await port().readEntry("never-written.txt");
		expect(entry.exists).toBe(false);
	});

	it("writing with expectedHash null creates a new entry, then a real read reflects it", async () => {
		const p = port();
		const result = await p.writeEntry("new.txt", null, "hello");
		expect(result.previousHash).toBeNull();
		expect(result.newHash).toMatch(/^[0-9a-f]{64}$/);
		expect(await p.readEntry("new.txt")).toEqual({ exists: true, content: "hello" });
	});

	it("writing with expectedHash null a second time rejects -- the entry already exists", async () => {
		const p = port();
		await p.writeEntry("dup.txt", null, "first");
		await expect(p.writeEntry("dup.txt", null, "second")).rejects.toThrow(StaleWorkspaceWrite);
	});

	it("writing with the correct observed hash overwrites; a stale hash rejects and leaves the entry unchanged", async () => {
		const p = port();
		const first = await p.writeEntry("overwrite.txt", null, "v1");
		const second = await p.writeEntry("overwrite.txt", first.newHash, "v2");
		expect(second.previousHash).toBe(first.newHash);
		await expect(p.writeEntry("overwrite.txt", "0".repeat(64), "clobber")).rejects.toThrow(StaleWorkspaceWrite);
		expect(await p.readEntry("overwrite.txt")).toEqual({ exists: true, content: "v2" });
	});
});
