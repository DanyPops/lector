import type { ContentHash } from "../domain/content-hash.ts";
import type { MutationHistoryEntry, MutationOperation } from "./mutation-history.ts";

export interface RecordMutationInput {
	readonly path: string;
	readonly operation: MutationOperation;
	readonly beforeContent: string | null;
	readonly beforeHash: ContentHash | null;
	readonly afterHash: ContentHash | null;
}

/**
 * MutationHistoryPort -- an append-only per-file mutation log, one instance per workspace. A
 * pure store, same philosophy as SymbolAnnotationPort: it never decides WHETHER a revert is
 * safe (see mutation-history.ts's canRevertMutation for that), only records entries and
 * serves them back. `record` never overwrites or removes a prior entry -- bounding total
 * storage (an explicit, required maxEntriesPerFile) evicts the OLDEST entry for that path, never
 * a caller-chosen one, so the audit trail's own ordering is never manipulable after the fact.
 */
export interface MutationHistoryPort {
	record(input: RecordMutationInput): Promise<MutationHistoryEntry>;
	/** Newest first, bounded by maxResults. */
	listForPath(path: string, maxResults: number): Promise<readonly MutationHistoryEntry[]>;
	get(id: string): Promise<MutationHistoryEntry | undefined>;
}
