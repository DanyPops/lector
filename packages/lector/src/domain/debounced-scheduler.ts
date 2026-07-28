/**
 * Coalesces a burst of calls for the same key into exactly one callback fire,
 * delayMs after the last call for that key -- the classic debounce shape,
 * used to turn a flurry of raw filesystem events from one logical save
 * (temp-file write + atomic rename can fire more than once) into a single
 * downstream refresh. Different keys are fully independent. Pure timer
 * bookkeeping, no I/O -- the callback itself does whatever real work is
 * needed.
 */

export class DebounceCapacityExceeded extends Error {
	constructor(
		readonly key: string,
		readonly max: number,
	) {
		super(`debounced scheduler distinct-key bound exceeded (${max}) scheduling key "${key}"`);
		this.name = "DebounceCapacityExceeded";
	}
}

export interface DebouncedSchedulerOptions {
	/** Maximum distinct keys with a pending fire at once. Default 4096. */
	readonly maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 4096;

export class DebouncedScheduler {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly delayMs: number;
	private readonly maxKeys: number;

	constructor(delayMs: number, options: DebouncedSchedulerOptions = {}) {
		if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError("delayMs must be a non-negative safe integer");
		this.delayMs = delayMs;
		this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
	}

	/**
	 * Schedules `callback` to run delayMs after this call, resetting any pending fire already
	 * scheduled for `key`. A callback that throws is caught and dropped -- there is no request
	 * awaiting this fire to report the error to, and an uncaught exception inside a bare
	 * setTimeout would otherwise crash the whole process rather than just this one key's work.
	 * A caller that cares about its own errors should catch and log inside `callback` itself.
	 */
	schedule(key: string, callback: () => void): void {
		const existing = this.timers.get(key);
		if (existing) {
			clearTimeout(existing);
		} else if (this.timers.size >= this.maxKeys) {
			throw new DebounceCapacityExceeded(key, this.maxKeys);
		}
		const timer = setTimeout(() => {
			this.timers.delete(key);
			try {
				callback();
			} catch {
				// Swallowed by design -- see doc comment above.
			}
		}, this.delayMs);
		this.timers.set(key, timer);
	}

	/** Cancels `key`'s pending fire, if any. Idempotent -- an unknown or already-fired key is a safe no-op. */
	cancel(key: string): void {
		const existing = this.timers.get(key);
		if (!existing) return;
		clearTimeout(existing);
		this.timers.delete(key);
	}

	/** True while `key` has a fire pending. */
	has(key: string): boolean {
		return this.timers.has(key);
	}

	/** Cancels every pending key at once -- for clean shutdown. */
	clear(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}
