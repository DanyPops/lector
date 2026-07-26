import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { encodeJsonRpcMessage, type JsonRpcMessage, JsonRpcMessageLimitExceeded, JsonRpcStreamDecoder } from "./json-rpc-stream.ts";

export interface LanguageServerProcessOptions {
	command: string;
	args?: readonly string[];
	cwd: string;
	/** Extra environment variables merged over process.env for the spawned process. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Per-request timeout. Default 10s. */
	requestTimeoutMs?: number;
	/** Maximum simultaneous requests. Default 64. */
	maxPendingRequests?: number;
	/** Maximum decoded server message size. Default 8 MiB. */
	maxMessageBytes?: number;
}

/** Raised when a request is sent (or was pending) after the server process already exited. */
export class LanguageServerProcessExited extends Error {
	constructor(readonly command: string) {
		super(`language server process "${command}" exited; the request cannot be fulfilled`);
		this.name = "LanguageServerProcessExited";
	}
}

/** Raised when a request does not receive a response within its timeout. */
export class LanguageServerCapacityExceeded extends Error {
	constructor(readonly maxPendingRequests: number) {
		super(`language server request capacity reached (${maxPendingRequests} pending)`);
		this.name = "LanguageServerCapacityExceeded";
	}
}

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

type NotificationHandler = (params: unknown) => void;

/**
 * A spawned language server subprocess with safe lifecycle management:
 * spawned detached so stop() can kill its whole process group, not just
 * the immediate child; a request made after the process has already
 * exited is rejected immediately rather than left pending forever; and
 * stop() force-kills the process group if a graceful shutdown doesn't
 * complete in time.
 */
export class LanguageServerProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly decoder: JsonRpcStreamDecoder;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
	private readonly requestTimeoutMs: number;
	private readonly maxPendingRequests: number;
	private readonly maxMessageBytes: number;
	private nextId = 1;
	private processExited = false;
	private exitError: Error;

	private constructor(child: ChildProcessWithoutNullStreams, label: string, requestTimeoutMs: number, maxPendingRequests: number, maxMessageBytes: number) {
		this.child = child;
		this.requestTimeoutMs = requestTimeoutMs;
		this.maxPendingRequests = maxPendingRequests;
		this.maxMessageBytes = maxMessageBytes;
		this.decoder = new JsonRpcStreamDecoder({ maxMessageBytes });
		this.exitError = new LanguageServerProcessExited(label);
		this.child.stderr.resume();

		this.child.stdout.on("data", (chunk: Buffer) => {
			try {
				for (const message of this.decoder.push(chunk)) this.dispatch(message);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});

		this.child.once("error", (error) => this.fail(error));
		this.child.once("exit", () => {
			this.processExited = true;
			for (const [id, request] of this.pending) {
				clearTimeout(request.timer);
				request.reject(this.exitError);
				this.pending.delete(id);
			}
		});
	}

	/** Undefined only if the OS never assigned one, i.e. spawn itself failed before this constructor ran. */
	get pid(): number | undefined {
		return this.child.pid;
	}

	static spawnProcess(options: LanguageServerProcessOptions): LanguageServerProcess {
		const maxPendingRequests = options.maxPendingRequests ?? 64;
		const maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
		if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1) throw new TypeError("maxPendingRequests must be a positive safe integer");
		if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new TypeError("maxMessageBytes must be a positive safe integer");
		const child = spawn(options.command, [...(options.args ?? [])], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group on POSIX so stop() can kill every descendant as a unit.
			detached: process.platform !== "win32",
		});
		return new LanguageServerProcess(child, options.command, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, maxPendingRequests, maxMessageBytes);
	}

	private dispatch(message: JsonRpcMessage): void {
		if (typeof message.id === "number") {
			const request = this.pending.get(message.id);
			if (!request) return;
			clearTimeout(request.timer);
			this.pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error.message));
			else request.resolve(message.result);
			return;
		}
		// No numeric id: either a notification (no id at all) or a server-initiated request
		// (its own id space, not this client's) -- only notifications are handled.
		if (message.id !== undefined || !message.method) return;
		for (const handler of this.notificationHandlers.get(message.method) ?? []) handler(message.params);
	}

	/** Subscribes to a server-pushed notification (e.g. textDocument/publishDiagnostics). Returns an unsubscribe function. */
	onNotification(method: string, handler: NotificationHandler): () => void {
		const handlers = this.notificationHandlers.get(method) ?? new Set();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => handlers.delete(handler);
	}

	async request<T>(method: string, params: unknown): Promise<T> {
		if (this.processExited) throw this.exitError;
		if (this.pending.size >= this.maxPendingRequests) throw new LanguageServerCapacityExceeded(this.maxPendingRequests);
		const id = this.nextId++;
		const message = encodeJsonRpcMessage({ jsonrpc: "2.0", id, method, params });
		if (message.byteLength > this.maxMessageBytes) throw new JsonRpcMessageLimitExceeded("message-bytes", this.maxMessageBytes, message.byteLength);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new LanguageServerRequestTimedOut(method, this.requestTimeoutMs));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
			this.child.stdin.write(message);
		});
	}

	notify(method: string, params: unknown): void {
		if (this.processExited) return;
		const message = encodeJsonRpcMessage({ jsonrpc: "2.0", method, params });
		if (message.byteLength > this.maxMessageBytes) throw new JsonRpcMessageLimitExceeded("message-bytes", this.maxMessageBytes, message.byteLength);
		this.child.stdin.write(message);
	}

	/**
	 * Attempts a graceful `shutdown` request followed by an `exit` notification,
	 * bounded by `stopTimeoutMs`. If the process has not exited by then -- the
	 * graceful path hung, errored, or the process simply ignored it -- kills
	 * the entire process group so no descendant is left running.
	 */
	private fail(error: Error): void {
		if (this.processExited) return;
		this.processExited = true;
		this.exitError = error;
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(error);
			this.pending.delete(id);
		}
		this.killProcessGroup();
	}

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
			const pid = this.child.pid;
			if (process.platform !== "win32" && pid !== undefined) {
				process.kill(-pid, "SIGKILL"); // negative pid == the whole process group
			} else {
				this.child.kill("SIGKILL");
			}
		} catch {
			// ESRCH etc. -- already gone.
		}
	}
}
