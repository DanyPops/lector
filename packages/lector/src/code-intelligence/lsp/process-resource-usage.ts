import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * Real RSS memory (kilobytes) a process and every one of its descendants
 * currently hold, read from /proc -- a server like typescript-language-server
 * spawns tsserver as a child process that would otherwise go uncounted.
 * Returns undefined where /proc is unavailable (non-Linux), never throws.
 */
export function measureProcessTreeRssKb(rootPid: number): number | undefined {
	if (!existsSync("/proc")) return undefined;

	const childrenByParent = buildParentIndex();
	const stack = [rootPid];
	const seen = new Set<number>();
	let totalKb = 0;

	while (stack.length > 0) {
		const pid = stack.pop();
		if (pid === undefined || seen.has(pid)) continue;
		seen.add(pid);
		totalKb += readRssKb(pid) ?? 0;
		for (const child of childrenByParent.get(pid) ?? []) stack.push(child);
	}
	return totalKb;
}

function readRssKb(pid: number): number | undefined {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf-8");
		const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
		return match?.[1] ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

function buildParentIndex(): Map<number, number[]> {
	const index = new Map<number, number[]>();
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return index;
	}
	for (const entry of entries) {
		const pid = Number(entry);
		if (!Number.isInteger(pid)) continue;
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf-8");
			const match = status.match(/^PPid:\s+(\d+)$/m);
			const ppid = match?.[1] ? Number(match[1]) : undefined;
			if (ppid === undefined) continue;
			const siblings = index.get(ppid);
			if (siblings) siblings.push(pid);
			else index.set(ppid, [pid]);
		} catch {
			// Process exited between readdir and read -- not a real descendant to count.
		}
	}
	return index;
}
