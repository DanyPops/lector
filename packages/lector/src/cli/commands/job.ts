import { connectPushChannel } from "@danypops/vehicle-client/daemon-client";
import { connectLectorClient, resolveLectorDaemonConnection } from "../../client.ts";
import type { JobSnapshot } from "../../concurrency/bounded-job-executor.ts";
import type { PopulateSymbolGraphResult } from "../../symbol-graph/populate-symbol-graph.ts";
import { fail, flagValue, hasFlag } from "../flags.ts";
import { formatJobSnapshot } from "../format.ts";
import { USAGE } from "../usage.ts";

/** job.status/job.wait -- the background-job admin pair, dispatched independently of the workspace.populateSymbolGraph operation itself (the only job type today). */

export async function runJobStatus(jobId: string | undefined, flags: string[]): Promise<void> {
	if (!jobId) fail(USAGE);
	const client = await connectLectorClient();
	const { job } = await client.call("job.status", { jobId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(job) : formatJobSnapshot(job));
}

export async function runJobWait(jobId: string | undefined, flags: string[]): Promise<void> {
	if (!jobId) fail(USAGE);
	const waitMsRaw = flagValue(flags, "--wait-ms");
	const waitMs = waitMsRaw === undefined ? 300_000 : Number(waitMsRaw);
	if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 300_000) fail("--wait-ms must be an integer from 1 to 300000");
	const client = await connectLectorClient();
	const initial = (await client.call("job.status", { jobId })).job;
	if (initial.status === "succeeded" || initial.status === "failed") {
		console.log(hasFlag(flags, "--json") ? JSON.stringify(initial) : formatJobSnapshot(initial));
		return;
	}
	const { topic } = await client.call("job.watch", { jobId });
	const initialTarget = resolveLectorDaemonConnection();
	let terminal: JobSnapshot<PopulateSymbolGraphResult> | undefined;
	let checking = false;
	let resolveDone!: () => void;
	let rejectDone!: (error: unknown) => void;
	const done = new Promise<void>((resolvePromise, rejectPromise) => {
		resolveDone = resolvePromise;
		rejectDone = rejectPromise;
	});
	const refresh = async (): Promise<void> => {
		if (checking || terminal) return;
		checking = true;
		try {
			const current = (await client.call("job.status", { jobId })).job;
			if (current.status === "succeeded" || current.status === "failed") {
				terminal = current;
				resolveDone();
			}
		} catch (error) {
			rejectDone(error);
		} finally {
			checking = false;
		}
	};
	const channel = connectPushChannel({
		url: () => {
			const target = resolveLectorDaemonConnection();
			return `ws://${target.host}:${target.port}/push`;
		},
		token: initialTarget.token,
		topics: [topic],
		onMessage: (receivedTopic) => {
			if (receivedTopic === topic) refresh().catch(rejectDone);
		},
	});
	const pollTimer = setInterval(() => {
		refresh().catch(rejectDone);
	}, 1_000);
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolvePromise) => {
		timeoutTimer = setTimeout(resolvePromise, waitMs);
	});
	try {
		await refresh();
		await Promise.race([done, timeout]);
	} finally {
		clearInterval(pollTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		channel.close();
	}
	const result = terminal ?? (await client.call("job.status", { jobId })).job;
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : formatJobSnapshot(result));
}

const JOB_ACTIONS: Record<string, (jobId: string | undefined, flags: string[]) => Promise<void>> = {
	status: runJobStatus,
	wait: runJobWait,
};

export async function runJob(rest: string[]): Promise<void> {
	const [action, jobId, ...jobFlags] = rest;
	const handler = action ? JOB_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(jobId, jobFlags);
}
