import { describe, expect, it } from "bun:test";
import { BoundedJobExecutor, JobCapacityExceeded, JobNotFound } from "../../src/concurrency/bounded-job-executor.ts";
import { recordingLogger } from "../support/recording-logger.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function executor(overrides: Partial<ConstructorParameters<typeof BoundedJobExecutor>[0]> = {}) {
	let id = 0;
	let now = 1_000;
	return {
		executor: new BoundedJobExecutor({
			maxConcurrent: 1,
			maxQueued: 2,
			maxRetained: 2,
			retentionMs: 1_000,
			createId: () => `job-${++id}`,
			now: () => now,
			...overrides,
		}),
		advance(ms: number) {
			now += ms;
		},
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition did not become true within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("BoundedJobExecutor", () => {
	it("returns immediately with a running snapshot, then exposes the typed result after completion", async () => {
		const work = deferred<{ count: number }>();
		const { executor: jobs } = executor();

		const submitted = jobs.submit({ operation: "workspace.populateSymbolGraph", priority: "local", run: () => work.promise });
		expect(submitted).toMatchObject({ id: "job-1", status: "running", operation: "workspace.populateSymbolGraph", priority: "local" });

		work.resolve({ count: 7 });
		expect(await jobs.wait(submitted.id, 100)).toMatchObject({ status: "succeeded", result: { count: 7 } });
	});

	it("notifies terminal subscribers exactly once with the completed snapshot", async () => {
		const work = deferred<{ count: number }>();
		const { executor: jobs } = executor();
		const submitted = jobs.submit({ operation: "workspace.populateSymbolGraph", priority: "local", run: () => work.promise });
		const observed: unknown[] = [];
		jobs.onTerminal(submitted.id, (snapshot) => observed.push(snapshot));

		work.resolve({ count: 7 });
		await jobs.wait(submitted.id, 100);

		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({ id: submitted.id, status: "succeeded", result: { count: 7 } });
	});

	it("captures and logs a bounded machine-readable failure without rejecting unrelated callers", async () => {
		const { logger, calls } = recordingLogger();
		const { executor: jobs } = executor({ logger });
		const submitted = jobs.submit({
			operation: "workspace.populateSymbolGraph",
			priority: "local",
			run: () => Promise.reject(new TypeError("language server crashed")),
		});

		expect(await jobs.wait(submitted.id, 100)).toMatchObject({
			status: "failed",
			error: { code: "TypeError", message: "language server crashed" },
		});
		expect(calls).toContainEqual({
			level: "warn",
			message: "background job failed",
			fields: { component: "background-jobs", operation: "workspace.populateSymbolGraph", priority: "local", code: "TypeError" },
		});
		expect(calls).toContainEqual({
			level: "debug",
			message: "background job submitted",
			fields: {
				component: "background-jobs",
				operation: "workspace.populateSymbolGraph",
				priority: "local",
				status: "running",
				runningJobs: 1,
				queuedJobs: 0,
			},
		});
		expect(JSON.stringify(calls)).not.toContain("language server crashed");
		expect(JSON.stringify(calls)).not.toContain(submitted.id);
	});

	it("never runs more than maxConcurrent jobs", async () => {
		const first = deferred<void>();
		const second = deferred<void>();
		const { executor: jobs } = executor();
		const started: string[] = [];

		jobs.submit({
			operation: "first",
			priority: "local",
			run: () => {
				started.push("first");
				return first.promise;
			},
		});
		const queued = jobs.submit({
			operation: "second",
			priority: "local",
			run: () => {
				started.push("second");
				return second.promise;
			},
		});
		expect(queued.status).toBe("queued");
		await waitUntil(() => started.length === 1);
		expect(started).toEqual(["first"]);

		first.resolve();
		await waitUntil(() => started.length === 2);
		expect(started).toEqual(["first", "second"]);
		second.resolve();
	});

	it("starts queued local work before older fetched-repo work, preserving FIFO within each priority", async () => {
		const blocker = deferred<void>();
		const remote = deferred<void>();
		const localA = deferred<void>();
		const localB = deferred<void>();
		const { executor: jobs } = executor({ maxQueued: 3 });
		const started: string[] = [];
		const submit = (name: string, priority: "local" | "remote", work: ReturnType<typeof deferred<void>>) =>
			jobs.submit({
				operation: name,
				priority,
				run: () => {
					started.push(name);
					return work.promise;
				},
			});

		submit("blocker", "local", blocker);
		submit("remote", "remote", remote);
		submit("local-a", "local", localA);
		submit("local-b", "local", localB);
		await waitUntil(() => started.length === 1);
		blocker.resolve();
		await waitUntil(() => started.length === 2);
		expect(started).toEqual(["blocker", "local-a"]);
		localA.resolve();
		await waitUntil(() => started.length === 3);
		expect(started).toEqual(["blocker", "local-a", "local-b"]);
		localB.resolve();
		await waitUntil(() => started.length === 4);
		expect(started).toEqual(["blocker", "local-a", "local-b", "remote"]);
		remote.resolve();
	});

	it("rejects submission when the bounded queue is full and logs bounded machine fields", () => {
		const never = new Promise<void>(() => {});
		const { logger, calls } = recordingLogger();
		const { executor: jobs } = executor({ maxQueued: 1, logger });
		jobs.submit({ operation: "running", priority: "local", run: () => never });
		jobs.submit({ operation: "queued", priority: "local", run: () => never });

		expect(() => jobs.submit({ operation: "overflow", priority: "local", run: () => never })).toThrow(JobCapacityExceeded);
		expect(calls).toContainEqual({
			level: "warn",
			message: "background job submission rejected",
			fields: { component: "background-jobs", operation: "overflow", priority: "local", code: "JobCapacityExceeded" },
		});
	});

	it("expires terminal jobs after retentionMs and explains that process-lifetime jobs do not survive restart", async () => {
		const { executor: jobs, advance } = executor();
		const submitted = jobs.submit({ operation: "quick", priority: "local", run: () => Promise.resolve("done") });
		await jobs.wait(submitted.id, 100);
		advance(1_001);

		expect(() => jobs.status(submitted.id)).toThrow(JobNotFound);
		expect(() => jobs.status(submitted.id)).toThrow("expired, was evicted, or belonged to a previous daemon process");
	});

	it("retains at most maxRetained terminal jobs", async () => {
		const { executor: jobs } = executor({ maxConcurrent: 3, maxRetained: 2 });
		const ids = ["one", "two", "three"].map((name) => jobs.submit({ operation: name, priority: "local", run: () => Promise.resolve(name) }).id);
		await jobs.wait(ids[2] as string, 100);

		expect(() => jobs.status(ids[0] as string)).toThrow(JobNotFound);
		expect(jobs.status(ids[1] as string).status).toBe("succeeded");
		expect(jobs.status(ids[2] as string).status).toBe("succeeded");
	});
});
