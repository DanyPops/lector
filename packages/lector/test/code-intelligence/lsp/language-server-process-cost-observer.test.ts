import { describe, expect, it } from "bun:test";
import { BoundedProcTreeCostObserver, type ProcessDirectoryPort } from "../../../src/code-intelligence/lsp/language-server-process-cost-observer.ts";

class FakeProcDirectory implements ProcessDirectoryPort {
	private readonly statusByPid = new Map<number, string>();

	setStatus(pid: number, options: { readonly ppid?: number; readonly rssKb?: number; readonly raw?: string }): void {
		if (options.raw !== undefined) {
			this.statusByPid.set(pid, options.raw);
			return;
		}
		const lines: string[] = [];
		if (options.ppid !== undefined) lines.push(`PPid:\t${options.ppid}`);
		if (options.rssKb !== undefined) lines.push(`VmRSS:\t${options.rssKb} kB`);
		this.statusByPid.set(pid, lines.join("\n"));
	}

	remove(pid: number): void {
		this.statusByPid.delete(pid);
	}

	readdir(path: string): readonly string[] {
		if (path !== "/proc") throw new Error(`unexpected readdir path: ${path}`);
		return Array.from(this.statusByPid.keys(), (pid) => String(pid));
	}

	readText(path: string): string {
		const match = path.match(/^\/proc\/(\d+)\/status$/);
		const pid = match?.[1] ? Number(match[1]) : undefined;
		const status = pid !== undefined ? this.statusByPid.get(pid) : undefined;
		if (status === undefined) throw new Error(`ENOENT: ${path}`);
		return status;
	}
}

class ThrowingProcDirectory implements ProcessDirectoryPort {
	readdir(): readonly string[] {
		throw new Error("ENOENT: /proc");
	}
	readText(): string {
		throw new Error("ENOENT");
	}
}

describe("BoundedProcTreeCostObserver", () => {
	it("sums RSS across a real child-process tree, in bytes", () => {
		const files = new FakeProcDirectory();
		files.setStatus(100, { ppid: 1, rssKb: 1000 });
		files.setStatus(101, { ppid: 100, rssKb: 2000 }); // child
		files.setStatus(102, { ppid: 101, rssKb: 500 }); // grandchild
		files.setStatus(999, { ppid: 1, rssKb: 999_999 }); // unrelated sibling process -- must not be counted

		const observer = new BoundedProcTreeCostObserver({ files });
		expect(observer.sampleTreeBytes(100)).toBe((1000 + 2000 + 500) * 1024);
	});

	it("returns undefined for /proc unavailable, without throwing", () => {
		const observer = new BoundedProcTreeCostObserver({ files: new ThrowingProcDirectory() });
		expect(observer.sampleTreeBytes(100)).toBeUndefined();
	});

	it("treats a disappeared descendant (status read fails) as a zero contribution, not a failed sample", () => {
		const files = new FakeProcDirectory();
		files.setStatus(100, { ppid: 1, rssKb: 1000 });
		files.setStatus(101, { ppid: 100, rssKb: 2000 });
		files.remove(101); // exited between building the parent index and reading its RSS

		const observer = new BoundedProcTreeCostObserver({ files });
		expect(observer.sampleTreeBytes(100)).toBe(1000 * 1024);
	});

	it("treats a malformed status file as a zero contribution, not a thrown error", () => {
		const files = new FakeProcDirectory();
		files.setStatus(100, { raw: "garbage, not a real /proc/status file at all\x00\x01" });
		files.setStatus(101, { ppid: 100, rssKb: 500 });

		const observer = new BoundedProcTreeCostObserver({ files });
		expect(observer.sampleTreeBytes(100)).toBe(500 * 1024);
	});

	it("never has a PPid at all for an orphaned/malformed entry -- excluded from the parent index, not crashing the scan", () => {
		const files = new FakeProcDirectory();
		files.setStatus(100, { ppid: 1, rssKb: 1000 });
		files.setStatus(200, { rssKb: 5000 }); // no PPid line

		const observer = new BoundedProcTreeCostObserver({ files });
		expect(observer.sampleTreeBytes(100)).toBe(1000 * 1024);
	});

	it("aborts the whole sample (undefined), not a partial sum, once the process-tree bound is exceeded", () => {
		const files = new FakeProcDirectory();
		files.setStatus(1, { ppid: 0, rssKb: 100 });
		let parent = 1;
		for (let child = 2; child <= 10; child++) {
			files.setStatus(child, { ppid: parent, rssKb: 100 });
			parent = child;
		}

		const observer = new BoundedProcTreeCostObserver({ files, maxProcessesVisited: 5 });
		expect(observer.sampleTreeBytes(1)).toBeUndefined();
	});

	it("aborts the whole sample once the wall-clock bound is exceeded", () => {
		const files = new FakeProcDirectory();
		files.setStatus(1, { ppid: 0, rssKb: 100 });
		let ticks = 0;
		const now = () => {
			ticks++;
			return ticks * 1000; // every call advances the fake clock by a full second
		};

		const observer = new BoundedProcTreeCostObserver({ files, maxDurationMs: 10, now });
		expect(observer.sampleTreeBytes(1)).toBeUndefined();
	});

	it("rejects an invalid root pid outright", () => {
		const observer = new BoundedProcTreeCostObserver({ files: new FakeProcDirectory() });
		expect(observer.sampleTreeBytes(0)).toBeUndefined();
		expect(observer.sampleTreeBytes(-5)).toBeUndefined();
		expect(observer.sampleTreeBytes(1.5)).toBeUndefined();
	});

	it("still measures the root process itself even when the parent-index scan bound is zero, missing only descendants", () => {
		const files = new FakeProcDirectory();
		files.setStatus(100, { ppid: 1, rssKb: 1000 });
		files.setStatus(101, { ppid: 100, rssKb: 2000 });

		const observer = new BoundedProcTreeCostObserver({ files, maxProcEntriesScanned: 1 });
		// With only one /proc entry ever scanned while building the parent index, the child
		// relationship may or may not be discovered depending on iteration order -- but a real
		// crash or a fabricated negative number would be a genuine defect either way.
		const result = observer.sampleTreeBytes(100);
		expect(result === 1000 * 1024 || result === 3000 * 1024).toBe(true);
	});

	it("rejects non-positive-integer construction bounds", () => {
		expect(() => new BoundedProcTreeCostObserver({ maxProcessesVisited: 0 })).toThrow(/positive safe integer/);
		expect(() => new BoundedProcTreeCostObserver({ maxDurationMs: -1 })).toThrow(/positive safe integer/);
	});
});
