import { describe, expect, it } from "bun:test";
import {
	DynamicCapabilityCapacityExceeded,
	DynamicCapabilityRegistry,
	parseConfigurationItemCount,
	parseProgressCreateToken,
	parseProgressNotification,
	parseRegistrationRequest,
	parseUnregistrationRequest,
} from "../../src/domain/dynamic-capability-registry.ts";

describe("DynamicCapabilityRegistry", () => {
	it("tracks a registration and exposes zero watched-file patterns for an unrelated method", () => {
		const registry = new DynamicCapabilityRegistry();
		registry.register("reg-1", "textDocument/formatting", {});
		expect(registry.registrationCount).toBe(1);
		expect(registry.watchedFilePatterns).toEqual([]);
	});

	it("extracts watched-file glob patterns from a workspace/didChangeWatchedFiles registration", () => {
		const registry = new DynamicCapabilityRegistry();
		registry.register("reg-1", "workspace/didChangeWatchedFiles", { watchers: [{ globPattern: "**/*.ts", kind: 3 }, { globPattern: "**/*.json" }] });
		expect(registry.watchedFilePatterns).toEqual([
			{ globPattern: "**/*.ts", kind: 3 },
			{ globPattern: "**/*.json", kind: 7 }, // default: Create | Change | Delete
		]);
	});

	it("extracts the pattern portion of a RelativePattern-shaped globPattern", () => {
		const registry = new DynamicCapabilityRegistry();
		registry.register("reg-1", "workspace/didChangeWatchedFiles", { watchers: [{ globPattern: { baseUri: "file:///repo", pattern: "src/**/*.ts" } }] });
		expect(registry.watchedFilePatterns).toEqual([{ globPattern: "src/**/*.ts", kind: 7 }]);
	});

	it("skips malformed watcher entries rather than throwing", () => {
		const registry = new DynamicCapabilityRegistry();
		registry.register("reg-1", "workspace/didChangeWatchedFiles", { watchers: [null, {}, { globPattern: 42 }, "not an object"] });
		expect(registry.watchedFilePatterns).toEqual([]);
	});

	it("unregister removes a registration's patterns, and is idempotent for an unknown id", () => {
		const registry = new DynamicCapabilityRegistry();
		registry.register("reg-1", "workspace/didChangeWatchedFiles", { watchers: [{ globPattern: "**/*.ts" }] });
		registry.unregister("reg-1");
		expect(registry.watchedFilePatterns).toEqual([]);
		expect(() => registry.unregister("never-registered")).not.toThrow();
	});

	it("re-registering the same id does not grow the bounded count", () => {
		const registry = new DynamicCapabilityRegistry({ maxRegistrations: 1 });
		registry.register("reg-1", "workspace/didChangeWatchedFiles", {});
		expect(() => registry.register("reg-1", "workspace/didChangeWatchedFiles", {})).not.toThrow();
		expect(registry.registrationCount).toBe(1);
	});

	it("rejects a new registration beyond the bounded count instead of growing without limit", () => {
		const registry = new DynamicCapabilityRegistry({ maxRegistrations: 1 });
		registry.register("reg-1", "workspace/didChangeWatchedFiles", {});
		expect(() => registry.register("reg-2", "workspace/didChangeWatchedFiles", {})).toThrow(DynamicCapabilityCapacityExceeded);
	});

	it("tracks progress tokens bounded the same way", () => {
		const registry = new DynamicCapabilityRegistry({ maxProgressTokens: 1 });
		registry.createProgressToken("token-1");
		expect(registry.progressTokenCount).toBe(1);
		expect(() => registry.createProgressToken("token-1")).not.toThrow(); // same token again: no growth
		expect(() => registry.createProgressToken("token-2")).toThrow(DynamicCapabilityCapacityExceeded);
	});

	it("records and overwrites the latest $/progress value per token", () => {
		const registry = new DynamicCapabilityRegistry();
		registry.recordProgress("token-1", { kind: "begin", title: "indexing" });
		registry.recordProgress("token-1", { kind: "report", percentage: 50 });
		expect(registry.progressByToken.get("token-1")).toEqual({ kind: "report", percentage: 50 });
	});

	it("silently drops a progress update beyond the bounded token count rather than throwing -- a notification has no reply to withhold", () => {
		const registry = new DynamicCapabilityRegistry({ maxProgressTokens: 1 });
		registry.recordProgress("token-1", { kind: "begin" });
		expect(() => registry.recordProgress("token-2", { kind: "begin" })).not.toThrow();
		expect(registry.progressByToken.has("token-2")).toBe(false);
		expect(registry.progressByToken.get("token-1")).toEqual({ kind: "begin" });
	});
});

describe("server-initiated request parameter parsing", () => {
	it("parseRegistrationRequest extracts well-formed registrations and skips malformed ones", () => {
		const result = parseRegistrationRequest({
			registrations: [
				{ id: "reg-1", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [] } },
				{ id: "reg-2" }, // missing method
				"not an object",
			],
		});
		expect(result).toEqual([{ id: "reg-1", method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [] } }]);
	});

	it("parseRegistrationRequest returns an empty array for malformed params", () => {
		expect(parseRegistrationRequest(null)).toEqual([]);
		expect(parseRegistrationRequest({})).toEqual([]);
	});

	it("parseUnregistrationRequest reads the spec's own unregisterations field", () => {
		expect(parseUnregistrationRequest({ unregisterations: [{ id: "reg-1" }, { notAnId: true }] })).toEqual(["reg-1"]);
		expect(parseUnregistrationRequest({})).toEqual([]);
	});

	it("parseConfigurationItemCount returns the requested item count", () => {
		expect(parseConfigurationItemCount({ items: [{ section: "a" }, { section: "b" }] })).toBe(2);
		expect(parseConfigurationItemCount({})).toBe(0);
	});

	it("parseProgressCreateToken reads a string or number token, and undefined otherwise", () => {
		expect(parseProgressCreateToken({ token: "abc" })).toBe("abc");
		expect(parseProgressCreateToken({ token: 42 })).toBe(42);
		expect(parseProgressCreateToken({ token: {} })).toBeUndefined();
		expect(parseProgressCreateToken({})).toBeUndefined();
	});

	it("parseProgressNotification reads token and value, and undefined for a missing/malformed token", () => {
		expect(parseProgressNotification({ token: "abc", value: { kind: "report", percentage: 50 } })).toEqual({
			token: "abc",
			value: { kind: "report", percentage: 50 },
		});
		expect(parseProgressNotification({ token: 42, value: null })).toEqual({ token: 42, value: null });
		expect(parseProgressNotification({ value: {} })).toBeUndefined();
		expect(parseProgressNotification({})).toBeUndefined();
		expect(parseProgressNotification(null)).toBeUndefined();
	});
});
