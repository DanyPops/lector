import type { JobSnapshot, PopulateSymbolGraphResult, WorkspaceCacheStatus } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForDirectory } from "./lector-client.ts";

export interface WorkspaceCacheOperations {
	status(directory: string, maxFiles: number, maxSymbolsPerFile: number): Promise<WorkspaceCacheStatus>;
	submit(directory: string, maxFiles: number, maxSymbolsPerFile: number): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	jobStatus(jobId: string): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
}

export function createWorkspaceCacheOperations(): WorkspaceCacheOperations {
	return {
		status(directory, maxFiles, maxSymbolsPerFile) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.cacheStatus", { workspaceId, maxFiles, maxSymbolsPerFile });
				},
			);
		},
		submit(directory, maxFiles, maxSymbolsPerFile) {
			return withWorkspace(
				() => workspaceForDirectory(directory),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { job } = await client.call("job.submit", {
						operation: "workspace.populateSymbolGraph",
						input: { workspaceId, maxFiles, maxSymbolsPerFile },
						waitMs: 0,
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
	};
}

export type CachePresentationState =
	| { readonly status: "not-cached"; readonly reason: string }
	| { readonly status: "caching"; readonly jobId: string }
	| { readonly status: "finished-caching"; readonly job: JobSnapshot<PopulateSymbolGraphResult> & { readonly status: "succeeded" } }
	| { readonly status: "cached" };

export function describeCacheState(state: CachePresentationState): string {
	if (state.status === "not-cached") return `not cached (${state.reason})`;
	if (state.status === "caching") return `caching (job ${state.jobId})`;
	if (state.status === "finished-caching") return `finished caching (job ${state.job.id})`;
	return "cached";
}

export function cacheContextMessage(state: CachePresentationState): string {
	const prefix = `Lector workspace cache: ${describeCacheState(state)}.`;
	if (state.status === "not-cached") return `${prefix} Live code-intelligence operations remain available.`;
	if (state.status === "caching") return `${prefix} The cached graph is still building; use live code-intelligence operations until it is ready.`;
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

/** Drives one bounded session cache lifecycle; Pi event handlers only render its states. */
export async function monitorWorkspaceCache(operations: WorkspaceCacheOperations, options: MonitorWorkspaceCacheOptions): Promise<void> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const initial = await operations.status(options.directory, options.maxFiles, options.maxSymbolsPerFile);
	if (!options.shouldContinue()) return;
	if (initial.status === "cached") {
		options.onState({ status: "cached" });
		return;
	}

	let jobId: string;
	if (initial.status === "caching") {
		jobId = initial.jobId;
	} else {
		options.onState({ status: "not-cached", reason: initial.reason });
		const submitted = await operations.submit(options.directory, options.maxFiles, options.maxSymbolsPerFile);
		if (submitted.status === "failed") throw new Error(`${submitted.error.code}: ${submitted.error.message}`);
		if (submitted.status === "succeeded") {
			options.onState({ status: "finished-caching", job: submitted });
			options.onState({ status: "cached" });
			return;
		}
		jobId = submitted.id;
	}
	options.onState({ status: "caching", jobId });

	for (let poll = 0; poll < options.maxPolls && options.shouldContinue(); poll++) {
		await sleep(options.pollIntervalMs);
		if (!options.shouldContinue()) return;
		const job = await operations.jobStatus(jobId);
		if (job.status === "failed") throw new Error(`${job.error.code}: ${job.error.message}`);
		if (job.status === "succeeded") {
			options.onState({ status: "finished-caching", job });
			options.onState({ status: "cached" });
			return;
		}
	}
}
