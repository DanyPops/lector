/**
 * Runs async operations one at a time per key, in submission order, so two
 * concurrent callers touching the same key (e.g. the same open file path)
 * never race each other's side effects. Different keys run fully
 * independently and concurrently -- this is a per-key barrier, not one
 * global lock. One operation's failure never blocks or fails the next
 * queued operation for the same key; only ordering is serialized.
 */

export class SerialQueueCapacityExceeded extends Error {
	constructor(
		readonly limit: "queue-depth" | "distinct-keys",
		readonly key: string,
		readonly max: number,
	) {
		super(`serial execution queue ${limit} exceeded (${max}) for key "${key}"`);
		this.name = "SerialQueueCapacityExceeded";
	}
}

export interface SerialExecutionQueueOptions {
	/** Maximum operations queued (running + waiting) for one key at a time. Default 64. */
	readonly maxQueuedPerKey?: number;
	/** Maximum distinct keys with an active queue at once. Default 4096. */
	readonly maxKeys?: number;
}

const DEFAULT_MAX_QUEUED_PER_KEY = 64;
const DEFAULT_MAX_KEYS = 4096;

export class SerialExecutionQueue {
	private readonly tails = new Map<string, Promise<void>>();
	private readonly depths = new Map<string, number>();
	private readonly maxQueuedPerKey: number;
	private readonly maxKeys: number;

	constructor(options: SerialExecutionQueueOptions = {}) {
		this.maxQueuedPerKey = options.maxQueuedPerKey ?? DEFAULT_MAX_QUEUED_PER_KEY;
		this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
	}

	/** Number of operations currently running or waiting for `key` (0 if none). */
	depthOf(key: string): number {
		return this.depths.get(key) ?? 0;
	}

	async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const depth = this.depths.get(key) ?? 0;
		if (depth === 0 && this.tails.size >= this.maxKeys) throw new SerialQueueCapacityExceeded("distinct-keys", key, this.maxKeys);
		if (depth >= this.maxQueuedPerKey) throw new SerialQueueCapacityExceeded("queue-depth", key, this.maxQueuedPerKey);
		this.depths.set(key, depth + 1);

		const previousTail = this.tails.get(key) ?? Promise.resolve();
		let settleOwnTail: () => void;
		const ownTail = new Promise<void>((resolve) => {
			settleOwnTail = resolve;
		});
		this.tails.set(key, ownTail);

		await previousTail; // wait for our turn; previousTail never rejects, so no error propagates between operations
		try {
			return await operation();
		} finally {
			const remaining = (this.depths.get(key) ?? 1) - 1;
			if (remaining <= 0) {
				this.depths.delete(key);
				if (this.tails.get(key) === ownTail) this.tails.delete(key); // no one queued behind us
			} else {
				this.depths.set(key, remaining);
			}
			// Guaranteed assigned (Promise executors run synchronously); `?.()` would hang the next queue
			// entry silently instead of throwing if that were ever wrong.
			// biome-ignore lint/style/noNonNullAssertion: see comment above
			settleOwnTail!();
		}
	}
}
