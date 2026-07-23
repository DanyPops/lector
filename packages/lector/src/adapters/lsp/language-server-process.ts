import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { encodeJsonRpcMessage, JsonRpcStreamDecoder, type JsonRpcMessage } from "./json-rpc-stream.ts";

export interface LanguageServerProcessOptions {
	command: string;
	args?: readonly string[];
	cwd: string;
	/** Extra environment variables merged over process.env for the spawned process. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Per-request timeout. Default 10s. */
	requestTimeoutMs?: number;
}

/** Raised when a request is sent (or was pending) after the server process already exited. */
export class LanguageServerProcessExited extends Error {
	constructor(readonly command: string) {
		super(`language server process "${command}" exited; the request cannot be fulfilled`);
		this.name = "LanguageServerProcessExited";
	}
}

/** Raised when a request does not receive a response within its timeout. */
export class LanguageServerRequestTimedOut extends Error {
	constructor(
		readonly method: string,
		readonly timeoutMs: number,
	) {
		super(`language server request "${method}" did not respond within ${timeoutMs}ms`);
		this.name = "LanguageServerRequestTimedOut";
	}
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * A spawned language server subprocess with safe lifecycle management,
 * applying real, shipped-and-fixed bugs from Oculus's git history
 * (doc 0ed166de-3b18-4aab-ae43-84b0efacff37 §4):
 *
 *  - Spawned detached (its own process group on POSIX) so stop() can kill
 *    every descendant as a unit, not just the immediate child (Oculus ea504eb).
 *  - The `exit` listener is attached in the constructor, before any request
 *    can possibly be sent, and rejects every currently-pending request the
 *    moment the process dies. A *new* request made after that point is
 *    rejected immediately by an explicit `processExited` guard rather than
 *    ever creating a pending slot nothing can fulfil -- this is exactly the
 *    seam Oculus's PIV-BUG-2 ("the zombie race") was missing: a request
 *    created after the reader already observed death blocked forever there.
 *  - Every request has its own timeout; a timed-out request's pending slot
 *    is always removed so a very late, spurious response cannot resolve a
 *    promise the caller has already treated as failed (Oculus LCS-BUG-76 class).
 *  - stop() always attempts a graceful shutdown/exit first, then force-kills
 *    the whole process group if that does not complete in time -- no code
 *    path leaves the child, or any of its children, running as a zombie.
 */
export class LanguageServerProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly label: string;
	private readonly decoder = new JsonRpcStreamDecoder();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private nextId = 1;
	private processExited = false;
	private exitError: Error;

	private constructor(child: ChildProcessWithoutNullStreams, label: string, requestTimeoutMs: number) {
		this.child = child;
		this.label = label;
		this.requestTimeoutMs = requestTimeoutMs;
		this.exitError = new LanguageServerProcessExited(label);

		this.child.stdout.on("data", (chunk: Buffer) => {
			for (const message of this.decoder.push(chunk)) this.dispatch(message);
		});

		this.child.once("exit", () => {
			this.processExited = true;
			for (const [id, request] of this.pending) {
				clearTimeout(request.timer);
				request.reject(this.exitError);
				this.pending.delete(id);
			}
		});
	}

	static spawnProcess(options: LanguageServerProcessOptions): LanguageServerProcess {
		const child = spawn(options.command, [...(options.args ?? [])], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group on POSIX so stop() can kill every descendant as a unit.
			detached: process.platform !== "win32",
		}) as ChildProcessWithoutNullStreams;
		return new LanguageServerProcess(child, options.command, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	}

	private dispatch(message: JsonRpcMessage): void {
		if (typeof message.id !== "number") return; // a notification or server-initiated request -- not handled yet
		const request = this.pending.get(message.id);
		if (!request) return;
		clearTimeout(request.timer);
		this.pending.delete(message.id);
		if (message.error) request.reject(new Error(message.error.message));
		else request.resolve(message.result);
	}

	async request<T>(method: string, params: unknown): Promise<T> {
		if (this.processExited) throw this.exitError;
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new LanguageServerRequestTimedOut(method, this.requestTimeoutMs));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
			this.child.stdin.write(encodeJsonRpcMessage({ jsonrpc: "2.0", id, method, params }));
		});
	}

	notify(method: string, params: unknown): void {
		if (this.processExited) return;
		this.child.stdin.write(encodeJsonRpcMessage({ jsonrpc: "2.0", method, params }));
	}

	/**
	 * Attempts a graceful `shutdown` request followed by an `exit` notification,
	 * bounded by `stopTimeoutMs`. If the process has not exited by then -- the
	 * graceful path hung, errored, or the process simply ignored it -- kills
	 * the entire process group so no descendant is left running.
	 */
	async stop(stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
		if (this.processExited) return;

		const exited = new Promise<void>((resolve) => {
			if (this.processExited) resolve();
			else this.child.once("exit", () => resolve());
		});

		await Promise.race([
			(async () => {
				try {
					await this.request("shutdown", null);
					this.notify("exit", null);
				} catch {
					// Falls through to the hard kill below regardless of why the graceful
					// path failed (timeout, process already gone, protocol error, ...).
				}
			})(),
			new Promise<void>((resolve) => setTimeout(resolve, stopTimeoutMs)),
		]);

		if (!this.processExited) this.killProcessGroup();

		// Bounded wait for the exit event to actually land; stop() must itself never hang
		// even if, somehow, neither the graceful path nor SIGKILL produced one promptly.
		await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, stopTimeoutMs))]);
	}

	private killProcessGroup(): void {
		try {
			if (process.platform !== "win32" && this.child.pid) {
				process.kill(-this.child.pid, "SIGKILL"); // negative pid == the whole process group
			} else {
				this.child.kill("SIGKILL");
			}
		} catch {
			// ESRCH etc. -- already gone.
		}
	}
}
