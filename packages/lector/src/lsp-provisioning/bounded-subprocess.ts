import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface BoundedSubprocessResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	/** True if the process was killed for exceeding its own timeout budget -- code/signal reflect the kill, not a real exit. */
	readonly timedOut: boolean;
}

export interface BoundedSubprocessOptions {
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes?: number;
	/** Merged over the ambient process.env. */
	readonly env?: Record<string, string | undefined>;
}

/**
 * Spawns a one-shot subprocess (npm install, getconf, ldd) with a hard wall-clock timeout and
 * bounded stdout/stderr capture -- never throws for a normal non-zero exit or a timeout, only
 * for a genuine spawn failure (ENOENT: the binary itself isn't on PATH), so a caller can always
 * branch on the returned result rather than a mix of thrown errors and return values. This is
 * the concrete fix for the exact class of bug OpenCode's own PR #22872 found in production: an
 * unbounded install-adjacent subprocess call hanging a caller forever.
 */
export function runBoundedSubprocess(command: string, args: readonly string[], options: BoundedSubprocessOptions): Promise<BoundedSubprocessResult> {
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < maxOutputBytes) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < maxOutputBytes) stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ code, signal, stdout: stdout.slice(0, maxOutputBytes), stderr: stderr.slice(0, maxOutputBytes), timedOut });
		});
	});
}
