/**
 * Service-level wiring for workspace.watch/unwatch: real fs events flowing through a real
 * workspace root, matched against a real registered glob, published via an injected callback
 * (mirroring the real PushChannel.publish the daemon wires in production). Pure registry
 * logic is already covered directly in test/file-watcher/watch-registry.test.ts; NodeFsFileWatcher's
 * own real-fs-event correctness is covered in test/file-watcher/node-fs-file-watcher.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService, UnknownWorkspace, WatchLimitExceeded } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) return reject(new Error("timed out waiting for the expected condition"));
			setTimeout(check, 50);
		};
		check();
	});
}

describe("createLectorService's workspace.watch/unwatch", () => {
	it("rejects an unknown workspaceId before ever touching the filesystem", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("workspace.watch", { workspaceId: "never-registered", pattern: "*.ts" })).rejects.toBeInstanceOf(UnknownWorkspace);
	});

	it("publishes a real file-change event to the registered watch's own topic, matched by its own pattern", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-service-watch-"));
		const published: { topic: string; payload: unknown }[] = [];
		service = createLectorService(new Map(), { allowDynamicOnly: true, publish: (topic, payload) => published.push({ topic, payload }) });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const { watchId, topic } = await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });
		expect(watchId).toBeTruthy();
		expect(topic).toBe(`watch:${watchId}`);

		writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
		await waitFor(() => published.some((p) => p.topic === topic));

		const event = published.find((p) => p.topic === topic);
		expect(event?.payload).toMatchObject({ path: "a.ts", kind: "created" });
	});

	it("never publishes for a change that doesn't match the registered pattern", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-service-watch-"));
		const published: { topic: string; payload: unknown }[] = [];
		service = createLectorService(new Map(), { allowDynamicOnly: true, publish: (topic, payload) => published.push({ topic, payload }) });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });

		writeFileSync(join(root, "b.md"), "# not a ts file\n");
		// No positive assertion to wait for -- give the (real, async) watcher a real window to
		// have delivered a false-positive event, then assert none arrived.
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(published).toEqual([]);
	});

	it("stops publishing once unwatched, and reports unwatched: true exactly once", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-service-watch-"));
		const published: unknown[] = [];
		service = createLectorService(new Map(), { allowDynamicOnly: true, publish: (_topic, payload) => published.push(payload) });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const { watchId } = await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });

		expect(await service.dispatch("workspace.unwatch", { watchId })).toEqual({ unwatched: true });
		expect(await service.dispatch("workspace.unwatch", { watchId })).toEqual({ unwatched: false });

		writeFileSync(join(root, "after-unwatch.ts"), "export {};\n");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(published).toEqual([]);
	});

	it("rejects a new watch once a workspace already holds the maximum, surfacing WatchLimitExceeded", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-service-watch-"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		for (let n = 0; n < 32; n++) await service.dispatch("workspace.watch", { workspaceId, pattern: `*.${n}` });

		await expect(service.dispatch("workspace.watch", { workspaceId, pattern: "*.overflow" })).rejects.toBeInstanceOf(WatchLimitExceeded);
	});

	it("close() shuts down every real OS watcher it created, not just the handle file", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-service-watch-"));
		let closeCount = 0;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createFileWatcher: () => ({
				watch: () => ({
					close: () => {
						closeCount++;
					},
				}),
			}),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.watch", { workspaceId, pattern: "*.ts" });

		await service.close();
		service = undefined;

		expect(closeCount).toBe(1);
	});
});
