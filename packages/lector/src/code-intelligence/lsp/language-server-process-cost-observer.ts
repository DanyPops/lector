/**
 * Bounded runtime calibration's own /proc reader -- deliberately separate from
 * linux-cgroup-warm-index-resources.ts, which owns cgroup memory.current/high/max/events/pressure
 * parsing and must never grow a second, unrelated parsing responsibility. This file answers one
 * narrow question -- "how many bytes does this one process tree hold right now" -- and answers it
 * only within strict process/file/time bounds, failing closed (undefined) rather than ever
 * returning a partial, silently-too-low sample a caller might mistake for a full one.
 */
import { readdirSync, readFileSync } from "node:fs";

export interface ProcessDirectoryPort {
	readdir(path: string): readonly string[];
	readText(path: string): string;
}

/** Never exposes a PID or a path -- only the one number a caller can safely fold into a byte estimate. */
export interface LanguageServerProcessCostObserverPort {
	sampleTreeBytes(rootPid: number): number | undefined;
}

const NODE_PROCESS_DIRECTORY: ProcessDirectoryPort = {
	readdir: (path) => readdirSync(path),
	readText: (path) => readFileSync(path, "utf8"),
};

export interface BoundedProcTreeCostObserverOptions {
	readonly files?: ProcessDirectoryPort;
	readonly procRoot?: string;
	/** Caps the BFS over the process tree itself -- a real language server's own descendant count is a handful; a tree this large is either wrong or not worth the scan. */
	readonly maxProcessesVisited?: number;
	/** Caps how many /proc/<pid>/status reads build the parent index -- bounds the file-access cost of a single sample independent of overall system PID count. */
	readonly maxProcEntriesScanned?: number;
	/** Wall-clock budget for one whole sample; exceeding it aborts and returns undefined rather than a stale/partial number. */
	readonly maxDurationMs?: number;
	readonly now?: () => number;
}

const DEFAULT_MAX_PROCESSES_VISITED = 256;
const DEFAULT_MAX_PROC_ENTRIES_SCANNED = 4096;
const DEFAULT_MAX_DURATION_MS = 50;

/**
 * Real RSS bytes a language-server process and every one of its descendants currently hold.
 * Bounded on every axis a hostile or merely huge /proc could otherwise exploit: total processes
 * visited, total status files read while building the parent index, and wall-clock time. A
 * process that exits mid-scan, or whose status file is malformed, contributes zero rather than
 * aborting the whole sample -- that is normal churn, not a reason to distrust everything else
 * already measured. Exceeding a bound instead aborts the ENTIRE sample (returns undefined): a
 * partial sum from a truncated scan could quietly under-report real usage, which is the one
 * failure mode calibration must never produce.
 */
export class BoundedProcTreeCostObserver implements LanguageServerProcessCostObserverPort {
	private readonly files: ProcessDirectoryPort;
	private readonly procRoot: string;
	private readonly maxProcessesVisited: number;
	private readonly maxProcEntriesScanned: number;
	private readonly maxDurationMs: number;
	private readonly now: () => number;

	constructor(options: BoundedProcTreeCostObserverOptions = {}) {
		this.files = options.files ?? NODE_PROCESS_DIRECTORY;
		this.procRoot = options.procRoot ?? "/proc";
		this.maxProcessesVisited = options.maxProcessesVisited ?? DEFAULT_MAX_PROCESSES_VISITED;
		this.maxProcEntriesScanned = options.maxProcEntriesScanned ?? DEFAULT_MAX_PROC_ENTRIES_SCANNED;
		this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
		this.now = options.now ?? Date.now;
		for (const [name, value] of Object.entries({
			maxProcessesVisited: this.maxProcessesVisited,
			maxProcEntriesScanned: this.maxProcEntriesScanned,
			maxDurationMs: this.maxDurationMs,
		})) {
			if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
		}
	}

	private readStatus(pid: number): string | undefined {
		try {
			return this.files.readText(`${this.procRoot}/${pid}/status`);
		} catch {
			return undefined;
		}
	}

	private readRssKb(pid: number): number | undefined {
		const status = this.readStatus(pid);
		if (status === undefined) return undefined;
		const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
		return match?.[1] ? Number(match[1]) : undefined;
	}

	private readPpid(pid: number): number | undefined {
		const status = this.readStatus(pid);
		if (status === undefined) return undefined;
		const match = status.match(/^PPid:\s+(\d+)$/m);
		return match?.[1] ? Number(match[1]) : undefined;
	}

	private buildParentIndex(deadline: number): Map<number, number[]> | undefined {
		let entries: readonly string[];
		try {
			entries = this.files.readdir(this.procRoot);
		} catch {
			return undefined;
		}
		const index = new Map<number, number[]>();
		const scanLimit = Math.min(entries.length, this.maxProcEntriesScanned);
		for (let i = 0; i < scanLimit; i++) {
			if (this.now() > deadline) return undefined;
			const raw = entries[i];
			const pid = raw === undefined ? Number.NaN : Number(raw);
			if (!Number.isInteger(pid) || pid < 0) continue;
			const ppid = this.readPpid(pid);
			if (ppid === undefined) continue;
			const siblings = index.get(ppid);
			if (siblings) siblings.push(pid);
			else index.set(ppid, [pid]);
		}
		return index;
	}

	sampleTreeBytes(rootPid: number): number | undefined {
		if (!Number.isSafeInteger(rootPid) || rootPid < 1) return undefined;
		const deadline = this.now() + this.maxDurationMs;
		const childrenByParent = this.buildParentIndex(deadline);
		if (!childrenByParent) return undefined;

		const stack = [rootPid];
		const seen = new Set<number>();
		let totalKb = 0;
		let visited = 0;
		while (stack.length > 0) {
			if (this.now() > deadline) return undefined;
			const pid = stack.pop();
			if (pid === undefined || seen.has(pid)) continue;
			seen.add(pid);
			visited++;
			if (visited > this.maxProcessesVisited) return undefined;
			totalKb += this.readRssKb(pid) ?? 0;
			for (const child of childrenByParent.get(pid) ?? []) stack.push(child);
		}
		return totalKb * 1024;
	}
}
