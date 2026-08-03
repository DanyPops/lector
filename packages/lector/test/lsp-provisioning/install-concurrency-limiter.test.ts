import { describe, expect, it } from "bun:test";
import { InstallConcurrencyLimiter } from "../../src/lsp-provisioning/install-concurrency-limiter.ts";

describe("InstallConcurrencyLimiter", () => {
	it("grants up to maxConcurrent slots immediately", async () => {
		const limiter = new InstallConcurrencyLimiter(2);
		await limiter.acquire();
		await limiter.acquire();
		expect(limiter.activeCount).toBe(2);
	});

	it("queues a request beyond the concurrency bound until a slot is released", async () => {
		const limiter = new InstallConcurrencyLimiter(1);
		const release1 = await limiter.acquire();
		let grantedThird = false;
		const secondAcquire = limiter.acquire().then((release) => {
			grantedThird = true;
			return release;
		});
		await Promise.resolve(); // let the microtask queue settle -- the second acquire must still be pending
		expect(grantedThird).toBe(false);
		expect(limiter.queuedCount).toBe(1);

		release1();
		const release2 = await secondAcquire;
		expect(grantedThird).toBe(true);
		release2();
	});

	it("releasing twice is a no-op, never granting an extra slot beyond the bound", async () => {
		const limiter = new InstallConcurrencyLimiter(1);
		const release = await limiter.acquire();
		release();
		release();
		expect(limiter.activeCount).toBe(0);
	});
});
