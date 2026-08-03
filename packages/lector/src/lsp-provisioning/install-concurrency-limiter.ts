/**
 * A simple counting semaphore bounding total concurrent installs across every package, on top of
 * the per-package in-flight dedup LanguageServerProvisioner already does on its own -- two
 * different packages requested at once must not both start downloading/installing unbounded in
 * parallel, per this repo's own "bound every resource" standard.
 */
export class InstallConcurrencyLimiter {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly maxConcurrent: number) {
		if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError("maxConcurrent must be a positive integer");
	}

	/** Resolves once a slot is free; the returned function releases it. Always call the release function, even on failure -- a caller should use try/finally. */
	acquire(): Promise<() => void> {
		return new Promise((resolvePromise) => {
			const grant = () => {
				this.active++;
				let released = false;
				resolvePromise(() => {
					if (released) return;
					released = true;
					this.active--;
					const next = this.waiters.shift();
					if (next) next();
				});
			};
			if (this.active < this.maxConcurrent) grant();
			else this.waiters.push(grant);
		});
	}

	get activeCount(): number {
		return this.active;
	}

	get queuedCount(): number {
		return this.waiters.length;
	}
}
