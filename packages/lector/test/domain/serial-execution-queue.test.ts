import { describe, expect, it } from "bun:test";
import { SerialExecutionQueue, SerialQueueCapacityExceeded } from "../../src/domain/serial-execution-queue.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("SerialExecutionQueue", () => {
	it("runs operations for the same key strictly one at a time, in submission order", async () => {
		const queue = new SerialExecutionQueue();
		const order: string[] = [];
		const first = deferred<void>();

		const a = queue.run("path-a", async () => {
			order.push("a-start");
			await first.promise;
			order.push("a-end");
		});
		const b = queue.run("path-a", async () => {
			order.push("b-start");
			order.push("b-end");
		});

		// b must not have started yet -- a hasn't released the key.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual(["a-start"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
	});

	it("runs operations for different keys fully concurrently, never serializing across keys", async () => {
		const queue = new SerialExecutionQueue();
		const order: string[] = [];
		const holdA = deferred<void>();

		const a = queue.run("path-a", async () => {
			order.push("a-start");
			await holdA.promise;
			order.push("a-end");
		});
		const b = queue.run("path-b", async () => {
			order.push("b-start");
			order.push("b-end");
		});

		await b; // an independent key must complete without waiting on path-a at all
		expect(order).toEqual(["a-start", "b-start", "b-end"]);
		holdA.resolve();
		await a;
	});

	it("one operation's rejection does not block or fail the next queued operation for the same key", async () => {
		const queue = new SerialExecutionQueue();
		const failing = queue.run("path-a", () => Promise.reject(new Error("boom")));
		const succeeding = queue.run("path-a", () => Promise.resolve("ok"));

		await expect(failing).rejects.toThrow("boom");
		await expect(succeeding).resolves.toBe("ok");
	});

	it("depthOf reports queue depth while operations are pending and 0 once drained", async () => {
		const queue = new SerialExecutionQueue();
		const hold = deferred<void>();
		expect(queue.depthOf("path-a")).toBe(0);
		const running = queue.run("path-a", () => hold.promise);
		const queued = queue.run("path-a", () => Promise.resolve());
		expect(queue.depthOf("path-a")).toBe(2);
		hold.resolve();
		await Promise.all([running, queued]);
		expect(queue.depthOf("path-a")).toBe(0);
	});

	it("rejects a new operation beyond the per-key queue-depth bound", async () => {
		const queue = new SerialExecutionQueue({ maxQueuedPerKey: 1 });
		const hold = deferred<void>();
		const running = queue.run("path-a", () => hold.promise);
		expect(() => queue.run("path-a", () => Promise.resolve())).toThrow(SerialQueueCapacityExceeded);
		hold.resolve();
		await running;
	});

	it("rejects a new distinct key beyond the total-key bound, while an already-active key's queue keeps working", async () => {
		const queue = new SerialExecutionQueue({ maxKeys: 1 });
		const hold = deferred<void>();
		const running = queue.run("path-a", () => hold.promise);
		expect(() => queue.run("path-b", () => Promise.resolve())).toThrow(SerialQueueCapacityExceeded);
		// A second operation for the SAME already-active key is fine -- it's not a new distinct key.
		const queued = queue.run("path-a", () => Promise.resolve("still fine"));
		hold.resolve();
		await running;
		await expect(queued).resolves.toBe("still fine");
	});

	it("a key's bookkeeping is fully released once drained, so it can be reused later without hitting the key bound", async () => {
		const queue = new SerialExecutionQueue({ maxKeys: 1 });
		await queue.run("path-a", () => Promise.resolve());
		expect(queue.depthOf("path-a")).toBe(0);
		// path-a fully drained -- a different key must now be free to use the one available slot.
		await expect(queue.run("path-b", () => Promise.resolve("ok"))).resolves.toBe("ok");
	});
});
