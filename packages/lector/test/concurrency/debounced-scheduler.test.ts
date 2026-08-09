import { describe, expect, it } from "bun:test";
import { DebounceCapacityExceeded, DebouncedScheduler } from "../../src/concurrency/debounced-scheduler.ts";
import { recordingLogger } from "../support/recording-logger.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DebouncedScheduler", () => {
	it("fires the callback once, after the configured delay", async () => {
		const scheduler = new DebouncedScheduler(20);
		let calls = 0;
		scheduler.schedule("a", () => calls++);
		expect(calls).toBe(0);
		await wait(40);
		expect(calls).toBe(1);
	});

	it("coalesces a burst of scheduling calls for the same key into exactly one fire", async () => {
		const scheduler = new DebouncedScheduler(20);
		let calls = 0;
		for (let i = 0; i < 10; i++) {
			scheduler.schedule("a", () => calls++);
			await wait(2); // each call arrives well inside the previous one's debounce window
		}
		await wait(40);
		expect(calls).toBe(1);
	});

	it("resets the window on every call -- a fire only happens once calls genuinely stop for the full delay", async () => {
		const scheduler = new DebouncedScheduler(30);
		let calls = 0;
		scheduler.schedule("a", () => calls++);
		await wait(20); // inside the window -- must not have fired yet
		expect(calls).toBe(0);
		scheduler.schedule("a", () => calls++); // resets the window
		await wait(20); // still inside the reset window
		expect(calls).toBe(0);
		await wait(20); // now past the full 30ms since the last schedule() call
		expect(calls).toBe(1);
	});

	it("keeps different keys fully independent", async () => {
		const scheduler = new DebouncedScheduler(15);
		const fired: string[] = [];
		scheduler.schedule("a", () => fired.push("a"));
		await wait(5);
		scheduler.schedule("b", () => fired.push("b"));
		await wait(30);
		expect(fired.sort()).toEqual(["a", "b"]);
	});

	it("cancel() prevents a pending callback from ever firing", async () => {
		const scheduler = new DebouncedScheduler(15);
		let calls = 0;
		scheduler.schedule("a", () => calls++);
		scheduler.cancel("a");
		await wait(30);
		expect(calls).toBe(0);
	});

	it("cancel() on an unknown key is a safe no-op", () => {
		const scheduler = new DebouncedScheduler(15);
		expect(() => scheduler.cancel("never-scheduled")).not.toThrow();
	});

	it("has() reflects whether a key currently has a pending fire", async () => {
		const scheduler = new DebouncedScheduler(20);
		expect(scheduler.has("a")).toBe(false);
		scheduler.schedule("a", () => {});
		expect(scheduler.has("a")).toBe(true);
		await wait(40);
		expect(scheduler.has("a")).toBe(false);
	});

	it("clear() cancels every pending key at once", async () => {
		const scheduler = new DebouncedScheduler(15);
		let calls = 0;
		scheduler.schedule("a", () => calls++);
		scheduler.schedule("b", () => calls++);
		scheduler.clear();
		await wait(30);
		expect(calls).toBe(0);
	});

	it("one key's callback throwing logs its classification without exposing the message or blocking another key", async () => {
		const { logger, calls } = recordingLogger();
		const scheduler = new DebouncedScheduler(15, { logger });
		let bFired = false;
		scheduler.schedule("a", () => {
			throw new TypeError("secret-bearing detail");
		});
		scheduler.schedule("b", () => {
			bFired = true;
		});
		await wait(30);
		expect(bFired).toBe(true);
		expect(calls).toContainEqual({
			level: "warn",
			message: "debounced callback failed",
			fields: { component: "debounced-scheduler", operation: "fire", code: "TypeError" },
		});
		expect(JSON.stringify(calls)).not.toContain("secret-bearing detail");
	});

	it("contains an async callback rejection without an unhandled rejection", async () => {
		const { logger, calls } = recordingLogger();
		const scheduler = new DebouncedScheduler(15, { logger });
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			scheduler.schedule("a", async () => {
				await Promise.resolve();
				throw new RangeError("secret-bearing async detail");
			});
			await wait(30);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
		expect(calls).toContainEqual({
			level: "warn",
			message: "debounced callback failed",
			fields: { component: "debounced-scheduler", operation: "fire", code: "RangeError" },
		});
		expect(JSON.stringify(calls)).not.toContain("secret-bearing async detail");
	});

	it("rejects and logs a new distinct key beyond the bound, while an already-pending key keeps working", async () => {
		const { logger, calls: logCalls } = recordingLogger();
		const scheduler = new DebouncedScheduler(15, { maxKeys: 1, logger });
		let callbackCalls = 0;
		scheduler.schedule("a", () => callbackCalls++);
		expect(() => scheduler.schedule("b", () => callbackCalls++)).toThrow(DebounceCapacityExceeded);
		expect(logCalls).toContainEqual({
			level: "warn",
			message: "debounced schedule rejected",
			fields: { component: "debounced-scheduler", operation: "schedule", code: "DebounceCapacityExceeded" },
		});
		// Re-scheduling the SAME already-pending key is not a new key -- must not be rejected.
		expect(() => scheduler.schedule("a", () => callbackCalls++)).not.toThrow();
		await wait(30);
		expect(callbackCalls).toBe(1);
	});

	it("a key's bookkeeping is released once it fires, so it can be scheduled again without hitting the key bound", async () => {
		const scheduler = new DebouncedScheduler(15, { maxKeys: 1 });
		let calls = 0;
		scheduler.schedule("a", () => calls++);
		await wait(30);
		expect(scheduler.has("a")).toBe(false);
		expect(() => scheduler.schedule("b", () => calls++)).not.toThrow();
		await wait(30);
		expect(calls).toBe(2);
	});
});
