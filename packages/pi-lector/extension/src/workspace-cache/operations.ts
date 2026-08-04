import { type JobSnapshot, type PopulateSymbolGraphResult, resolveLectorDaemonConnection, type WorkspaceCacheStatus } from "@danypops/lector";
import { connectPushChannel } from "@danypops/vehicle-client/daemon-client";
import { lectorClient, withWorkspace, workspaceForProjectDirectory } from "../lector-client.ts";

export interface JobWatchHandle {
	close(): void;
}

export type JobWatchOutcome = { readonly status: "subscribed"; readonly handle: JobWatchHandle } | { readonly status: "unavailable" };

export interface WorkspaceCacheOperations {
	status(directory: string, maxFiles: number, maxSymbolsPerFile: number): Promise<WorkspaceCacheStatus>;
	submit(directory: string, maxFiles: number, maxSymbolsPerFile: number, waitMs?: number): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	jobStatus(jobId: string): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	watchJob?(jobId: string, onJob: (job: JobSnapshot<PopulateSymbolGraphResult>) => void): Promise<JobWatchOutcome>;
}

export function createWorkspaceCacheOperations(): WorkspaceCacheOperations {
	return {
		status(directory, maxFiles, maxSymbolsPerFile) {
			return withWorkspace(
				() => workspaceForProjectDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.cacheStatus", { workspaceId, maxFiles, maxSymbolsPerFile });
				},
			);
		},
		submit(directory, maxFiles, maxSymbolsPerFile, waitMs = 0) {
			return withWorkspace(
				() => workspaceForProjectDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { job } = await client.callOnce("job.submit", {
						operation: "workspace.populateSymbolGraph",
						input: { workspaceId, maxFiles, maxSymbolsPerFile },
						waitMs,
					});
					return job;
				},
			);
		},
		async jobStatus(jobId) {
			const client = await lectorClient();
			const { job } = await client.call("job.status", { jobId });
			return job;
		},
		async watchJob(jobId, onJob) {
			try {
				const client = await lectorClient();
				const { topic } = await client.call("job.watch", { jobId });
				const initialTarget = resolveLectorDaemonConnection();
				const channel = connectPushChannel({
					url: () => {
						const target = resolveLectorDaemonConnection();
						return `ws://${target.host}:${target.port}/push`;
					},
					token: initialTarget.token,
					topics: [topic],
					onMessage(receivedTopic) {
						if (receivedTopic !== topic) return;
						void client
							.call("job.status", { jobId })
							.then(({ job }) => onJob(job))
							.catch(() => {
								// The bounded status cadence remains authoritative when push refresh fails.
							});
					},
				});
				return { status: "subscribed", handle: { close: () => channel.close() } };
			} catch {
				return { status: "unavailable" };
			}
		},
	};
}

export type CachePresentationState =
	| { readonly status: "not-cached"; readonly reason: string }
	| { readonly status: "caching"; readonly jobId: string }
	| { readonly status: "finished-caching"; readonly job: JobSnapshot<PopulateSymbolGraphResult> & { readonly status: "succeeded" } }
	| { readonly status: "partial"; readonly result: PopulateSymbolGraphResult }
	| { readonly status: "cached" };

export function describeCacheState(state: CachePresentationState): string {
	if (state.status === "not-cached") return `not cached (${state.reason})`;
	if (state.status === "caching") return `caching (job ${state.jobId})`;
	if (state.status === "finished-caching") return `finished caching (job ${state.job.id})`;
	if (state.status === "partial") return `partially cached (${state.result.filesFailed} failed file${state.result.filesFailed === 1 ? "" : "s"})`;
	return "cached";
}

export function cacheContextMessage(state: CachePresentationState): string {
	const prefix = `Lector workspace cache: ${describeCacheState(state)}.`;
	if (state.status === "not-cached") return `${prefix} Live code-intelligence operations remain available.`;
	if (state.status === "caching") return `${prefix} The cached graph is still building; use live code-intelligence operations until it is ready.`;
	if (state.status === "partial") return `${prefix} The graph is usable, but live code-intelligence operations are required for failed files.`;
	return `${prefix} The cached graph is ready.`;
}

export interface MonitorWorkspaceCacheOptions {
	readonly directory: string;
	readonly maxFiles: number;
	readonly maxSymbolsPerFile: number;
	readonly pollIntervalMs: number;
	readonly maxPolls: number;
	readonly shouldContinue: () => boolean;
	readonly onState: (state: CachePresentationState) => void;
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface WaitForJobCompletionOptions {
	readonly pollIntervalMs: number;
	readonly maxPolls: number;
	readonly shouldContinue: () => boolean;
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
}

/** Waits on Vehicle push delivery and checks status on a bounded cadence when push is unavailable or disconnected. */
export async function waitForJobCompletion(
	operations: WorkspaceCacheOperations,
	jobId: string,
	options: WaitForJobCompletionOptions,
): Promise<JobSnapshot<PopulateSymbolGraphResult> | undefined> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let pushedResolve: ((job: JobSnapshot<PopulateSymbolGraphResult>) => void) | undefined;
	const pushed = new Promise<JobSnapshot<PopulateSymbolGraphResult>>((resolve) => {
		pushedResolve = resolve;
	});
	let watch: JobWatchHandle | undefined;
	let resolveAbort!: () => void;
	const aborted = new Promise<void>((resolve) => {
		resolveAbort = resolve;
	});
	const onAbort = () => resolveAbort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const outcome = await operations.watchJob?.(jobId, (job) => pushedResolve?.(job));
		if (outcome?.status === "subscribed") watch = outcome.handle;
		for (let poll = 0; poll < options.maxPolls && options.shouldContinue() && !options.signal?.aborted; poll++) {
			const current = await operations.jobStatus(jobId);
			if (current.status === "succeeded" || current.status === "failed") return current;
			const next = await Promise.race([pushed, sleep(options.pollIntervalMs).then(() => undefined), aborted.then(() => undefined)]);
			if (next?.status === "succeeded" || next?.status === "failed") return next;
		}
		if (options.shouldContinue() && !options.signal?.aborted) return operations.jobStatus(jobId);
		return undefined;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		watch?.close();
	}
}

/** Drives one bounded session cache lifecycle; Pi event handlers only render its states. */
export async function monitorWorkspaceCache(operations: WorkspaceCacheOperations, options: MonitorWorkspaceCacheOptions): Promise<void> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const initial = await operations.status(options.directory, options.maxFiles, options.maxSymbolsPerFile);
	if (!options.shouldContinue()) return;
	if (initial.status === "cached") {
		options.onState({ status: "cached" });
		return;
	}
	if (initial.status === "partial") {
		options.onState({ status: "partial", result: initial.generation.result });
		return;
	}

	function reportCompleted(job: JobSnapshot<PopulateSymbolGraphResult> & { readonly status: "succeeded" }): void {
		options.onState({ status: "finished-caching", job });
		options.onState(job.result.completeness === "partial" ? { status: "partial", result: job.result } : { status: "cached" });
	}

	let jobId: string;
	if (initial.status === "caching") {
		jobId = initial.jobId;
	} else {
		options.onState({ status: "not-cached", reason: initial.reason });
		const submitted = await operations.submit(options.directory, options.maxFiles, options.maxSymbolsPerFile);
		if (submitted.status === "failed") throw new Error(`${submitted.error.code}: ${submitted.error.message}`);
		if (submitted.status === "succeeded") {
			reportCompleted(submitted);
			return;
		}
		jobId = submitted.id;
	}
	options.onState({ status: "caching", jobId });

	const job = await waitForJobCompletion(operations, jobId, {
		pollIntervalMs: options.pollIntervalMs,
		maxPolls: options.maxPolls,
		shouldContinue: options.shouldContinue,
		sleep,
	});
	if (job?.status === "failed") throw new Error(`${job.error.code}: ${job.error.message}`);
	if (job?.status === "succeeded") reportCompleted(job);
}
