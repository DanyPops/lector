import { Buffer } from "node:buffer";

const MAX_STDERR_BYTES = 64 * 1024;

export interface BoundedGitCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maxBytes: number, onLimit: () => void): Promise<{ value: string; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let retainedBytes = 0;
	let truncated = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			const remaining = maxBytes - retainedBytes;
			const retained = next.value.subarray(0, Math.max(0, remaining));
			chunks.push(retained);
			retainedBytes += retained.byteLength;
			if (next.value.byteLength > remaining) {
				truncated = true;
				onLimit();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { value: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), truncated };
}

/** Runs one read-only Git command with bounded stdout/stderr retention and caller cancellation. */
export async function runBoundedGitCommand(
	cwd: string,
	args: readonly string[],
	maxStdoutBytes: number,
	signal: AbortSignal,
): Promise<BoundedGitCommandResult> {
	signal.throwIfAborted();
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", signal });
	const stop = () => {
		try {
			process.kill();
		} catch {
			// The process may have exited between the stream read and the bound check.
		}
	};
	const [stdout, stderr, exitCode] = await Promise.all([
		readBoundedStream(process.stdout, maxStdoutBytes, stop),
		readBoundedStream(process.stderr, MAX_STDERR_BYTES, stop),
		process.exited,
	]);
	signal.throwIfAborted();
	return {
		stdout: stdout.value,
		stderr: stderr.value,
		exitCode,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
	};
}
