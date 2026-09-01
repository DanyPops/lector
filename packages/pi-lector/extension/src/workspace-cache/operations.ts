import {
	type CacheResultCounts,
	type JobSnapshot,
	type OperationOutputs,
	type PopulateSymbolGraphResult,
	remoteErrorIs,
	resolveLectorDaemonConnection,
	type WorkspaceCacheStatus,
} from "@danypops/lector";
import { connectPushChannel } from "@danypops/vehicle-client/daemon-client";
import { forgetWorkspaceId, lectorClient, withWorkspace, workspaceForProjectDirectory } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

export interface JobWatchHandle {
	close(): void;
}

export type JobWatchOutcome = { readonly status: "subscribed"; readonly handle: JobWatchHandle } | { readonly status: "unavailable" };

/**
 * The daemon's own default (0/omitted -- fail fast on a WorkspaceChangedDuringPopulation race)
 * would surface a live-editing/rename race straight to this tool's own caller as an opaque
 * error. This tool's whole point is "make this converge for me" -- a bounded background retry
 * costs the caller nothing extra (it runs inside the job the caller is already waiting on or
 * polling, not as additional synchronous tool-call latency), so it defaults on here specifically,
 * unlike the raw daemon operation which stays fail-fast by default for programmatic callers that
 * want today's exact contract.
 */
const DEFAULT_POPULATE_RETRY_TIME_BUDGET_MS = 60_000;
const WORKSPACE_RELEASE_PERMISSIONS = ["workspace:write"];

export interface WorkspaceCacheOperations {
	status(directory: string, maxFiles: number, maxSymbolsPerFile: number): Promise<WorkspaceCacheStatus>;
	release(directory: string, call: LectorVehicleCall): Promise<OperationOutputs["workspace.release"]>;
	submit(
		directory: string,
		maxFiles: number,
		maxSymbolsPerFile: number,
		waitMs?: number,
		retryTimeBudgetMs?: number,
	): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	jobStatus(jobId: string): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	watchJob?(jobId: string, onJob: (job: JobSnapshot<PopulateSymbolGraphResult>) => void): Promise<JobWatchOutcome>;
}

export type WorkspaceCacheMonitorOperations = Omit<WorkspaceCacheOperations, "release">;

export function createWorkspaceCacheOperations(ownerId?: string): WorkspaceCacheOperations {
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
		release(directory, call) {
			return withWorkspace(
				() => workspaceForProjectDirectory(directory),
				async ({ workspaceId, root }) => {
					const result = await invokeLectorVehicleOperation<OperationOutputs["workspace.release"]>(
						"workspace.release",
						{ workspaceId },
						WORKSPACE_RELEASE_PERMISSIONS,
						call,
					);
					forgetWorkspaceId(root);
					return result;
				},
			);
		},
		submit(directory, maxFiles, maxSymbolsPerFile, waitMs = 0, retryTimeBudgetMs = DEFAULT_POPULATE_RETRY_TIME_BUDGET_MS) {
			return withWorkspace(
				() => workspaceForProjectDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { job } = await client.callOnce("job.submit", {
						operation: "workspace.populateSymbolGraph",
						input: { workspaceId, maxFiles, maxSymbolsPerFile, retryTimeBudgetMs },
						waitMs,
						...(ownerId ? { ownerId } : {}),
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
	| { readonly status: "partial"; readonly result: CacheResultCounts }
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

/**
 * Exhaustive outcome of waiting on one job -- every path monitorWorkspaceCache must reconcile
 * against authoritative workspace.cacheStatus, distinct from a genuine terminal result:
 * "job-not-found" (the id expired, was evicted, or survives from a since-restarted daemon),
 * "timed-out" (the bounded poll budget was spent and the job is still non-terminal), and
 * "transport-failed" (the daemon couldn't be reached at all) all mean "we no longer know this
 * job's real state" -- never treated as if the job were still "caching" forever.
 */
export type JobCompletionOutcome =
	| { readonly kind: "terminal"; readonly job: JobSnapshot<PopulateSymbolGraphResult> & { readonly status: "succeeded" | "failed" } }
	| { readonly kind: "timed-out" }
	| { readonly kind: "canceled" }
	| { readonly kind: "job-not-found" }
	| { readonly kind: "transport-failed"; readonly error: unknown };

/** Waits on Vehicle push delivery and checks status on a bounded cadence when push is unavailable or disconnected. */
export async function waitForJobCompletion(
	operations: WorkspaceCacheMonitorOperations,
	jobId: string,
	options: WaitForJobCompletionOptions,
): Promise<JobCompletionOutcome> {
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

	async function checkStatus(): Promise<JobCompletionOutcome | undefined> {
		try {
			const current = await operations.jobStatus(jobId);
			if (current.status === "succeeded" || current.status === "failed") return { kind: "terminal", job: current };
			return undefined;
		} catch (error) {
			if (remoteErrorIs(error, "JobNotFound")) return { kind: "job-not-found" };
			return { kind: "transport-failed", error };
		}
	}

	try {
		const subscription = await operations.watchJob?.(jobId, (job) => pushedResolve?.(job));
		if (subscription?.status === "subscribed") watch = subscription.handle;
		for (let poll = 0; poll < options.maxPolls && options.shouldContinue() && !options.signal?.aborted; poll++) {
			const checked = await checkStatus();
			if (checked) return checked;
			const next = await Promise.race([pushed, sleep(options.pollIntervalMs).then(() => undefined), aborted.then(() => undefined)]);
			if (next?.status === "succeeded" || next?.status === "failed") return { kind: "terminal", job: next };
		}
		if (!options.shouldContinue() || options.signal?.aborted) return { kind: "canceled" };
		return (await checkStatus()) ?? { kind: "timed-out" };
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		watch?.close();
	}
}

/** Drives one bounded session cache lifecycle; Pi event handlers only render its states. */
export async function monitorWorkspaceCache(operations: WorkspaceCacheMonitorOperations, options: MonitorWorkspaceCacheOptions): Promise<void> {
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
	if (initial.status === "caching" || initial.status === "waiting-for-resources") {
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

	const outcome = await waitForJobCompletion(operations, jobId, {
		pollIntervalMs: options.pollIntervalMs,
		maxPolls: options.maxPolls,
		shouldContinue: options.shouldContinue,
		sleep,
	});
	if (outcome.kind === "canceled") return;
	if (outcome.kind === "terminal") {
		if (outcome.job.status === "failed") throw new Error(`${outcome.job.error.code}: ${outcome.job.error.message}`);
		reportCompleted(outcome.job);
		return;
	}
	// job-not-found, timed-out, and transport-failed all mean the same thing here: this specific
	// watch no longer knows the job's real state. Never leave the last-reported "caching" message
	// standing -- ask the daemon's own authoritative record what is actually true right now.
	const reconciled = await operations.status(options.directory, options.maxFiles, options.maxSymbolsPerFile);
	if (reconciled.status === "cached") {
		options.onState({ status: "cached" });
	} else if (reconciled.status === "partial") {
		options.onState({ status: "partial", result: reconciled.generation.result });
	} else if (reconciled.status === "not-cached") {
		options.onState({ status: "not-cached", reason: reconciled.reason });
	} else {
		// Still genuinely caching or queued behind resource admission under a fresh check --
		// an accurate report, not a stale one, even though the presented status string repeats.
		options.onState({ status: "caching", jobId: reconciled.jobId });
	}
}
