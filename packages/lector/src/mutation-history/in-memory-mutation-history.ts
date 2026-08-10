import { randomUUID } from "node:crypto";
import type { MutationHistoryEntry } from "./mutation-history.ts";
import type { MutationHistoryPort, RecordMutationInput } from "./port.ts";

const DEFAULT_MAX_ENTRIES_PER_FILE = 50;

/** In-memory MutationHistoryPort -- does not survive a daemon restart, matching how SymbolGraphPort/SymbolAnnotationPort both started before a durable SQLite variant existed. */
export class InMemoryMutationHistory implements MutationHistoryPort {
	private readonly byId = new Map<string, MutationHistoryEntry>();
	/** Newest-last per path, so eviction (oldest first) and listing (newest first, reversed on read) are both a single end of the same array. */
	private readonly idsByPath = new Map<string, string[]>();
	private readonly maxEntriesPerFile: number;

	constructor(maxEntriesPerFile: number = DEFAULT_MAX_ENTRIES_PER_FILE) {
		if (!Number.isSafeInteger(maxEntriesPerFile) || maxEntriesPerFile < 1) {
			throw new TypeError("maxEntriesPerFile must be a positive safe integer");
		}
		this.maxEntriesPerFile = maxEntriesPerFile;
	}

	async record(input: RecordMutationInput): Promise<MutationHistoryEntry> {
		const entry: MutationHistoryEntry = { id: randomUUID(), timestamp: Date.now(), ...input };
		this.byId.set(entry.id, entry);
		const ids = this.idsByPath.get(input.path) ?? [];
		ids.push(entry.id);
		while (ids.length > this.maxEntriesPerFile) {
			const evicted = ids.shift();
			if (evicted) this.byId.delete(evicted);
		}
		this.idsByPath.set(input.path, ids);
		return entry;
	}

	async listForPath(path: string, maxResults: number): Promise<readonly MutationHistoryEntry[]> {
		const ids = this.idsByPath.get(path) ?? [];
		const newestFirst = [...ids].reverse();
		return newestFirst
			.slice(0, maxResults)
			.map((id) => this.byId.get(id))
			.filter((entry): entry is MutationHistoryEntry => entry !== undefined);
	}

	async get(id: string): Promise<MutationHistoryEntry | undefined> {
		return this.byId.get(id);
	}

	async listByTransaction(transactionId: string): Promise<readonly MutationHistoryEntry[]> {
		return [...this.byId.values()].filter((entry) => entry.transactionId === transactionId);
	}
}
