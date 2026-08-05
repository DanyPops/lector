import type { WorkspaceQueryOutcome } from "./workspace-query-outcome.ts";

/**
 * Runs one workspace's query against a time budget without ever cancelling it: a timeout means
 * this call reports "loading" and stops waiting, but the real work (e.g. LspSymbolIndex's own
 * cached, shared initialization) keeps running in the background regardless -- a later call
 * against the same workspace finds it already warm. Never throws: a genuine failure becomes an
 * "error" outcome for this one workspace, not a rejection that would abort an entire fan-out.
 */
export function raceWorkspaceQuery<T>(
	workspaceId: string,
	run: () => Promise<T>,
	timeoutMs: number,
	loadingMessage: string,
): Promise<WorkspaceQueryOutcome<T>> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve({ workspaceId, status: "loading", message: loadingMessage });
		}, timeoutMs);

		run().then(
			(result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ workspaceId, status: "ready", result });
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ workspaceId, status: "error", message: error instanceof Error ? error.message : String(error) });
			},
		);
	});
}
