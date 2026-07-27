import { describe, expect, it } from "bun:test";
import { WatchLimitExceeded, WatchRegistry } from "../../src/domain/watch-registry.ts";

describe("WatchRegistry", () => {
	it("adds a registration and returns it back", () => {
		const registry = new WatchRegistry();
		const registration = registry.add("ws-1", "*.ts", "watch-1", "watch:watch-1");
		expect(registration).toEqual({ watchId: "watch-1", workspaceId: "ws-1", pattern: "*.ts", topic: "watch:watch-1" });
	});

	it("lists every registration for a workspace, and none for an unknown one", () => {
		const registry = new WatchRegistry();
		registry.add("ws-1", "*.ts", "watch-1", "watch:watch-1");
		registry.add("ws-1", "*.md", "watch-2", "watch:watch-2");
		registry.add("ws-2", "*.go", "watch-3", "watch:watch-3");

		expect(
			registry
				.registrationsFor("ws-1")
				.map((r) => r.watchId)
				.sort(),
		).toEqual(["watch-1", "watch-2"]);
		expect(registry.registrationsFor("ws-2").map((r) => r.watchId)).toEqual(["watch-3"]);
		expect(registry.registrationsFor("never-registered")).toEqual([]);
	});

	it("removes a registration, returning it, and only the first time", () => {
		const registry = new WatchRegistry();
		registry.add("ws-1", "*.ts", "watch-1", "watch:watch-1");

		expect(registry.remove("watch-1")).toEqual({ watchId: "watch-1", workspaceId: "ws-1", pattern: "*.ts", topic: "watch:watch-1" });
		expect(registry.remove("watch-1")).toBeUndefined();
		expect(registry.registrationsFor("ws-1")).toEqual([]);
	});

	it("removing an unknown watchId is idempotent, not an error", () => {
		const registry = new WatchRegistry();
		expect(registry.remove("never-existed")).toBeUndefined();
	});

	it("hasAnyFor reflects whether a workspace still has at least one live registration", () => {
		const registry = new WatchRegistry();
		expect(registry.hasAnyFor("ws-1")).toBe(false);

		registry.add("ws-1", "*.ts", "watch-1", "watch:watch-1");
		expect(registry.hasAnyFor("ws-1")).toBe(true);

		registry.remove("watch-1");
		expect(registry.hasAnyFor("ws-1")).toBe(false);
	});

	it("rejects a new watch once a workspace already holds the maximum", () => {
		const registry = new WatchRegistry();
		for (let n = 0; n < 32; n++) registry.add("ws-1", "*.ts", `watch-${n}`, `watch:watch-${n}`);

		expect(() => registry.add("ws-1", "*.md", "watch-32", "watch:watch-32")).toThrow(WatchLimitExceeded);
		// A different workspace is unaffected by another workspace's own limit.
		expect(() => registry.add("ws-2", "*.md", "watch-other", "watch:watch-other")).not.toThrow();
	});

	it("removing a watch frees a slot for a workspace that was previously at its limit", () => {
		const registry = new WatchRegistry();
		for (let n = 0; n < 32; n++) registry.add("ws-1", "*.ts", `watch-${n}`, `watch:watch-${n}`);
		registry.remove("watch-0");

		expect(() => registry.add("ws-1", "*.md", "watch-new", "watch:watch-new")).not.toThrow();
	});
});
