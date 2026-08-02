/**
 * NodeFsFileWatcher against a real directory and Bun's own real fs.watch -- no mocked
 * filesystem or fabricated events.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangeEvent } from "../../src/file-watcher/file-change-event.ts";
import { NodeFsFileWatcher } from "../../src/file-watcher/node-fs-file-watcher.ts";

function waitForEvent(events: FileChangeEvent[], predicate: (event: FileChangeEvent) => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			if (events.some(predicate)) return resolve();
			if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out waiting for a matching event; saw: ${JSON.stringify(events)}`));
			setTimeout(check, 50);
		};
		check();
	});
}

describe("NodeFsFileWatcher", () => {
	it("reports a real file creation", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-fs-watcher-"));
		const watcher = new NodeFsFileWatcher();
		const events: FileChangeEvent[] = [];
		const handle = watcher.watch(root, (event) => events.push(event));
		try {
			writeFileSync(join(root, "new.txt"), "hello");
			await waitForEvent(events, (e) => e.path === "new.txt" && e.kind === "created");
		} finally {
			handle.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a real content modification to an existing file", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-fs-watcher-"));
		writeFileSync(join(root, "a.txt"), "original");
		const watcher = new NodeFsFileWatcher();
		const events: FileChangeEvent[] = [];
		const handle = watcher.watch(root, (event) => events.push(event));
		try {
			writeFileSync(join(root, "a.txt"), "changed");
			await waitForEvent(events, (e) => e.path === "a.txt" && e.kind === "modified");
		} finally {
			handle.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a real file deletion", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-fs-watcher-"));
		writeFileSync(join(root, "gone.txt"), "will be deleted");
		const watcher = new NodeFsFileWatcher();
		const events: FileChangeEvent[] = [];
		const handle = watcher.watch(root, (event) => events.push(event));
		try {
			unlinkSync(join(root, "gone.txt"));
			await waitForEvent(events, (e) => e.path === "gone.txt" && e.kind === "deleted");
		} finally {
			handle.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a real change in a nested subdirectory (recursive watching)", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-fs-watcher-"));
		mkdirSync(join(root, "sub"));
		const watcher = new NodeFsFileWatcher();
		const events: FileChangeEvent[] = [];
		const handle = watcher.watch(root, (event) => events.push(event));
		try {
			writeFileSync(join(root, "sub", "nested.txt"), "hello");
			await waitForEvent(events, (e) => e.path.replace(/\\/g, "/") === "sub/nested.txt" && e.kind === "created");
		} finally {
			handle.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stops delivering events once closed", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-fs-watcher-"));
		const watcher = new NodeFsFileWatcher();
		const events: FileChangeEvent[] = [];
		const handle = watcher.watch(root, (event) => events.push(event));
		handle.close();

		writeFileSync(join(root, "after-close.txt"), "hello");
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(events).toEqual([]);
		rmSync(root, { recursive: true, force: true });
	});
});
