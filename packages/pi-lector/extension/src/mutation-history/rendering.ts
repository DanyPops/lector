import type { MutationHistoryEntry } from "@danypops/lector";
import type { MutationTransactionRevertOutcome } from "./operations.ts";

export function formatMutationHistoryList(entries: readonly MutationHistoryEntry[]): string {
	if (entries.length === 0) return "no recorded mutation history for this path";
	return entries
		.map((entry) => {
			const grouping = entry.transactionId === null ? "standalone mutation" : `transaction ${entry.transactionId}`;
			return `${entry.id}  ${new Date(entry.timestamp).toISOString()}  ${entry.operation}  ${grouping}`;
		})
		.join("\n");
}

export function formatMutationTransactionRevert(originalTransactionId: string, outcome: MutationTransactionRevertOutcome): string {
	switch (outcome.status) {
		case "reverted":
			return [
				`${originalTransactionId} reverted atomically; revert recorded as transaction ${outcome.transactionId}`,
				...outcome.reverted.map((entry) => `${entry.path} -> ${entry.newHash ?? "(deleted)"}`),
			].join("\n");
		case "stale":
			return `${originalTransactionId} is stale at ${outcome.stalePaths.length} path(s); no files were reverted\n${outcome.stalePaths.join("\n")}`;
		case "evicted":
			return `${originalTransactionId} cannot be reverted because its bounded process-local history was evicted`;
		case "wrong-workspace":
			return `${originalTransactionId} belongs to a different registered workspace; use a path from that workspace`;
		case "unknown":
			return `${originalTransactionId} is unknown; mutation history is process-local and is lost after daemon restart`;
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}
