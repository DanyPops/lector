import { describe, expect, it } from "bun:test";
import { runBoundedSubprocess } from "../../src/lsp-provisioning/bounded-subprocess.ts";

describe("runBoundedSubprocess", () => {
	it("captures stdout/stderr and the real exit code for a normal exit", async () => {
		const result = await runBoundedSubprocess("node", ["-e", "console.log('out'); console.error('err'); process.exit(3)"], { timeoutMs: 5000 });
		expect(result).toEqual({ code: 3, signal: null, stdout: "out\n", stderr: "err\n", timedOut: false });
	});

	it("kills a stalled process once the timeout elapses, marking timedOut instead of hanging the caller", async () => {
		const started = Date.now();
		const result = await runBoundedSubprocess("node", ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 });
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe("SIGKILL");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("truncates output past the configured byte bound rather than growing without limit", async () => {
		const result = await runBoundedSubprocess("node", ["-e", "process.stdout.write('x'.repeat(1000))"], { timeoutMs: 5000, maxOutputBytes: 100 });
		expect(result.stdout.length).toBeLessThanOrEqual(100);
	});

	it("rejects for a genuine spawn failure (binary not on PATH), never hanging or silently resolving", async () => {
		await expect(runBoundedSubprocess("this-binary-does-not-exist-anywhere", [], { timeoutMs: 1000 })).rejects.toThrow();
	});

	it("passes cwd through to the spawned process", async () => {
		const result = await runBoundedSubprocess("node", ["-e", "process.stdout.write(process.cwd())"], { timeoutMs: 5000, cwd: "/tmp" });
		expect(result.stdout).toBe("/tmp");
	});

	it("merges env over the ambient process.env rather than replacing it", async () => {
		const result = await runBoundedSubprocess("node", ["-e", "process.stdout.write(process.env.LECTOR_TEST_VAR + '|' + typeof process.env.PATH)"], {
			timeoutMs: 5000,
			env: { LECTOR_TEST_VAR: "custom-value" },
		});
		expect(result.stdout).toBe("custom-value|string");
	});
});
