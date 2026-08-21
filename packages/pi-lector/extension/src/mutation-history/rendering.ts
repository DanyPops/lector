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
	const lines = [
		`${originalTransactionId} reverted atomically; revert recorded as transaction ${outcome.transactionId}`,
		...outcome.reverted.map((entry) => `${entry.path} -> ${entry.newHash ?? "(deleted)"}`),
	];
	return lines.join("\n");
}
