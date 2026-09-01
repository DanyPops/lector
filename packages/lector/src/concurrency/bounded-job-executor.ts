import type { Logger } from "@danypops/vehicle-server/logging";

export type JobPriority = "local" | "remote";

interface JobIdentity {
	readonly id: string;
	readonly operation: string;
	readonly priority: JobPriority;
	readonly submittedAt: number;
}

export type JobSnapshot<Result = unknown> =
	| (JobIdentity & { readonly status: "queued" })
	| (JobIdentity & { readonly status: "running"; readonly startedAt: number })
	| (JobIdentity & { readonly status: "succeeded"; readonly startedAt: number; readonly finishedAt: number; readonly result: Result })
	| (JobIdentity & {
			readonly status: "failed";
			readonly startedAt?: number;
			readonly finishedAt: number;
			readonly error: { readonly code: string; readonly message: string };
	  });

export class JobCapacityExceeded extends Error {
	constructor(readonly maxQueued: number) {
		super(`background job queue is full (${maxQueued} queued); wait for a running job to finish before submitting more work`);
		this.name = "JobCapacityExceeded";
	}
}

export class JobNotFound extends Error {
	constructor(readonly jobId: string) {
		super(`background job "${jobId}" is unknown: it expired, was evicted, or belonged to a previous daemon process`);
		this.name = "JobNotFound";
	}
}

export class JobExecutorClosed extends Error {
	constructor() {
		super("background job executor is closed");
		this.name = "JobExecutorClosed";
	}
}

export interface BoundedJobExecutorOptions {
	readonly maxConcurrent: number;
	readonly maxQueued: number;
	readonly maxRetained: number;
	readonly retentionMs: number;
	readonly createId: () => string;
	readonly now?: () => number;
	readonly logger?: Logger;
}

interface JobEntry<Result> {
	snapshot: JobSnapshot<Result>;
	readonly run: () => Promise<Result>;
	readonly settled: Set<() => void>;
	readonly terminalListeners: Set<(snapshot: JobSnapshot<Result>) => void>;
}

const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Runs process-lifetime work with explicit concurrency, queue, retention, and priority bounds. */
export class BoundedJobExecutor<Result = unknown> {
	readonly #maxConcurrent: number;
	readonly #maxQueued: number;
	readonly #maxRetained: number;
	readonly #retentionMs: number;
	readonly #createId: () => string;
	readonly #now: () => number;
	readonly #logger: Logger;
	readonly #jobs = new Map<string, JobEntry<Result>>();
	readonly #queuedIds: string[] = [];
	readonly #terminalIds: string[] = [];
	#running = 0;
	#closed = false;

	constructor(options: BoundedJobExecutorOptions) {
		for (const [name, value] of [
			["maxConcurrent", options.maxConcurrent],
			["maxQueued", options.maxQueued],
			["maxRetained", options.maxRetained],
			["retentionMs", options.retentionMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value < (name === "maxConcurrent" ? 1 : 0)) {
				throw new RangeError(`${name} must be a ${name === "maxConcurrent" ? "positive" : "non-negative"} safe integer`);
			}
		}
		this.#maxConcurrent = options.maxConcurrent;
		this.#maxQueued = options.maxQueued;
		this.#maxRetained = options.maxRetained;
		this.#retentionMs = options.retentionMs;
		this.#createId = options.createId;
		this.#now = options.now ?? Date.now;
		this.#logger = options.logger ?? NOOP_LOGGER;
	}

	submit(input: { operation: string; priority: JobPriority; run: () => Promise<Result> }): JobSnapshot<Result> {
		if (this.#closed) {
			this.#logger.warn("background job submission rejected", {
				component: "background-jobs",
				operation: input.operation,
				priority: input.priority,
				code: "JobExecutorClosed",
			});
			throw new JobExecutorClosed();
		}
		this.reap();
		if (this.#running >= this.#maxConcurrent && this.#queuedIds.length >= this.#maxQueued) {
			this.#logger.warn("background job submission rejected", {
				component: "background-jobs",
				operation: input.operation,
				priority: input.priority,
				code: "JobCapacityExceeded",
			});
			throw new JobCapacityExceeded(this.#maxQueued);
		}

		const id = this.#createId();
		if (this.#jobs.has(id)) throw new Error(`createId returned duplicate background job id "${id}"`);
		const entry: JobEntry<Result> = {
			snapshot: { id, operation: input.operation, priority: input.priority, submittedAt: this.#now(), status: "queued" },
			run: input.run,
			settled: new Set(),
			terminalListeners: new Set(),
		};
		this.#jobs.set(id, entry);
		if (this.#running < this.#maxConcurrent) this.#start(entry);
		else this.#queuedIds.push(id);
		this.#logger.debug("background job submitted", {
			component: "background-jobs",
			operation: input.operation,
			priority: input.priority,
			status: entry.snapshot.status,
			runningJobs: this.#running,
			queuedJobs: this.#queuedIds.length,
		});
		return entry.snapshot;
	}

	status(jobId: string): JobSnapshot<Result> {
		this.reap();
		const entry = this.#jobs.get(jobId);
		if (!entry) throw new JobNotFound(jobId);
		return entry.snapshot;
	}

	onTerminal(jobId: string, listener: (snapshot: JobSnapshot<Result>) => void): () => void {
		const entry = this.#jobs.get(jobId);
		if (!entry) throw new JobNotFound(jobId);
		if (entry.snapshot.status === "succeeded" || entry.snapshot.status === "failed") {
			listener(entry.snapshot);
			return () => {};
		}
		entry.terminalListeners.add(listener);
		return () => entry.terminalListeners.delete(listener);
	}

	async wait(jobId: string, maxWaitMs: number): Promise<JobSnapshot<Result>> {
		if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) throw new RangeError("maxWaitMs must be a non-negative safe integer");
		const entry = this.#jobs.get(jobId);
		if (!entry) throw new JobNotFound(jobId);
		if (entry.snapshot.status === "succeeded" || entry.snapshot.status === "failed" || maxWaitMs === 0) return entry.snapshot;

		await new Promise<void>((resolve) => {
			const settled = () => {
				clearTimeout(timer);
				entry.settled.delete(settled);
				resolve();
			};
			entry.settled.add(settled);
			const timer = setTimeout(settled, maxWaitMs);
		});
		return this.status(jobId);
	}

	reap(): number {
		const now = this.#now();
		let removed = 0;
		while (this.#terminalIds.length > 0) {
			const id = this.#terminalIds[0];
			if (!id) break;
			const entry = this.#jobs.get(id);
			if (!entry || (entry.snapshot.status !== "succeeded" && entry.snapshot.status !== "failed")) {
				this.#terminalIds.shift();
				continue;
			}
			if (now - entry.snapshot.finishedAt <= this.#retentionMs) break;
			this.#terminalIds.shift();
			this.#jobs.delete(id);
			removed++;
		}
		return removed;
	}

	close(): void {
		this.#closed = true;
		for (const id of this.#queuedIds.splice(0)) {
			const entry = this.#jobs.get(id);
			if (entry) this.#finishFailure(entry, new JobExecutorClosed());
		}
	}

	#start(entry: JobEntry<Result>): void {
		this.#running++;
		entry.snapshot = { ...entry.snapshot, status: "running", startedAt: this.#now() };
		void Promise.resolve()
			.then(entry.run)
			.then(
				(result) => this.#finishSuccess(entry, result),
				(error: unknown) => this.#finishFailure(entry, error),
			);
	}

	#finishSuccess(entry: JobEntry<Result>, result: Result): void {
		if (entry.snapshot.status !== "running") return;
		entry.snapshot = { ...entry.snapshot, status: "succeeded", finishedAt: this.#now(), result };
		this.#finish(entry);
	}

	#finishFailure(entry: JobEntry<Result>, error: unknown): void {
		const wasRunning = entry.snapshot.status === "running";
		const failure = error instanceof Error ? error : new Error(String(error));
		entry.snapshot = {
			...entry.snapshot,
			status: "failed",
			finishedAt: this.#now(),
			error: { code: failure.name || "Error", message: failure.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
		};
		this.#logger.warn("background job failed", {
			component: "background-jobs",
			operation: entry.snapshot.operation,
			priority: entry.snapshot.priority,
			code: failure.name || "Error",
		});
		if (wasRunning) this.#running--;
		this.#recordTerminal(entry);
		if (wasRunning) this.#startNext();
	}

	#finish(entry: JobEntry<Result>): void {
		this.#running--;
		this.#recordTerminal(entry);
		this.#startNext();
	}

	#recordTerminal(entry: JobEntry<Result>): void {
		this.#terminalIds.push(entry.snapshot.id);
		for (const listener of entry.settled) listener();
		entry.settled.clear();
		for (const listener of entry.terminalListeners) listener(entry.snapshot);
		entry.terminalListeners.clear();
		while (this.#terminalIds.length > this.#maxRetained) {
			const evictedId = this.#terminalIds.shift();
			if (evictedId) this.#jobs.delete(evictedId);
		}
	}

	#startNext(): void {
		if (this.#closed || this.#running >= this.#maxConcurrent || this.#queuedIds.length === 0) return;
		const localIndex = this.#queuedIds.findIndex((id) => this.#jobs.get(id)?.snapshot.priority === "local");
		const index = localIndex >= 0 ? localIndex : 0;
		const [nextId] = this.#queuedIds.splice(index, 1);
		const next = nextId ? this.#jobs.get(nextId) : undefined;
		if (next) this.#start(next);
	}
}
