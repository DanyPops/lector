/**
 * NodeFsFileWatcher against a real directory and Bun's own real fs.watch -- no mocked
 * filesystem or fabricated events.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChangeEvent } from "../../src/file-watcher/file-change-event.ts";
import { classifyFileChange, NodeFsFileWatcher, SerializedFileChangeClassifier } from "../../src/file-watcher/node-fs-file-watcher.ts";

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

	it('classifies a brand-new path as created without ever consulting the platform\'s own raw event label -- the exact case a real CI runner got wrong by reporting a plain "change" event for a file that had never existed before', () => {
		const knownPaths = new Set<string>();
		expect(classifyFileChange("brand-new.txt", true, knownPaths)).toBe("created");
		expect(knownPaths.has("brand-new.txt")).toBe(true);
	});

	it("classifies a change to an already-known path as modified, not created", () => {
		const knownPaths = new Set<string>(["existing.txt"]);
		expect(classifyFileChange("existing.txt", true, knownPaths)).toBe("modified");
		expect(knownPaths.has("existing.txt")).toBe(true);
	});

	it("classifies a now-missing path as deleted and forgets it, regardless of whether it was previously known", () => {
		const knownPaths = new Set<string>(["tracked.txt"]);
		expect(classifyFileChange("tracked.txt", false, knownPaths)).toBe("deleted");
		expect(knownPaths.has("tracked.txt")).toBe(false);
		expect(classifyFileChange("never-seen.txt", false, knownPaths)).toBe("deleted");
	});

	it("does not mistake a pre-existing file's first observed change for its creation", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-fs-watcher-"));
		writeFileSync(join(root, "pre-existing.txt"), "seeded before watch() is ever called");
		const watcher = new NodeFsFileWatcher();
		const events: FileChangeEvent[] = [];
		const handle = watcher.watch(root, (event) => events.push(event));
		try {
			writeFileSync(join(root, "pre-existing.txt"), "changed after watch() started");
			await waitForEvent(events, (e) => e.path === "pre-existing.txt");
			expect(events.find((e) => e.path === "pre-existing.txt")?.kind).toBe("modified");
		} finally {
			handle.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes duplicate callbacks for one path so created is always delivered before any modified follow-up", async () => {
		const knownPaths = new Set<string>();
		const events: FileChangeEvent[] = [];
		const checks: ((exists: boolean) => void)[] = [];
		const classifier = new SerializedFileChangeClassifier(
			knownPaths,
			(event) => events.push(event),
			() => new Promise<boolean>((resolve) => checks.push(resolve)),
		);

		classifier.enqueue("new.txt");
		classifier.enqueue("new.txt");
		expect(checks).toHaveLength(1); // the duplicate is one bounded trailing recheck, never a concurrent stat
		checks.shift()?.(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual([{ path: "new.txt", kind: "created" }]);
		expect(checks).toHaveLength(1);
		checks.shift()?.(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual([
			{ path: "new.txt", kind: "created" },
			{ path: "new.txt", kind: "modified" },
		]);
	});

	it("coalesces any duplicate burst during one in-flight classification to one trailing recheck", async () => {
		const checks: ((exists: boolean) => void)[] = [];
		const classifier = new SerializedFileChangeClassifier(
			new Set(),
			() => undefined,
			() => new Promise<boolean>((resolve) => checks.push(resolve)),
		);
		classifier.enqueue("burst.txt");
		for (let index = 0; index < 100; index++) classifier.enqueue("burst.txt");
		expect(checks).toHaveLength(1);
		checks.shift()?.(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(checks).toHaveLength(1);
		checks.shift()?.(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(checks).toHaveLength(0);
	});

	it("drops an in-flight classification that finishes after close", async () => {
		const events: FileChangeEvent[] = [];
		let finish: ((exists: boolean) => void) | undefined;
		const classifier = new SerializedFileChangeClassifier(
			new Set(),
			(event) => events.push(event),
			() => new Promise<boolean>((resolve) => (finish = resolve)),
		);
		classifier.enqueue("late.txt");
		classifier.close();
		finish?.(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual([]);
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
