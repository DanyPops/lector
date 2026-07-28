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

/** Raised by onRequest when a second handler is registered for a method that already has one -- a server-initiated request needs exactly one reply. */
export class DuplicateRequestHandler extends Error {
	constructor(readonly method: string) {
		super(`a request handler is already registered for "${method}"`);
		this.name = "DuplicateRequestHandler";
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

/** A server-initiated request handler. May return synchronously or asynchronously; a thrown error becomes a JSON-RPC InternalError response. */
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

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
	private readonly requestHandlers = new Map<string, RequestHandler>();
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
		// A JSON-RPC response never carries "method" -- that is the correct discriminator (not the
		// id's type), since a server-initiated request's own id could otherwise collide on the wire
		// with one of this client's own pending numeric ids from an independent id space.
		if (message.method === undefined) {
			if (typeof message.id !== "number") return; // a response must echo one of our own numeric ids
			const request = this.pending.get(message.id);
			if (!request) return;
			clearTimeout(request.timer);
			this.pending.delete(message.id);
			if (message.error) request.reject(new Error(message.error.message));
			else request.resolve(message.result);
			return;
		}
		if (message.id === undefined) {
			for (const handler of this.notificationHandlers.get(message.method) ?? []) handler(message.params);
			return;
		}
		// Has both a method and an id: a server-initiated request. A spec-compliant server blocks
		// waiting for a reply, so every such request must get one -- MethodNotFound if unhandled,
		// never silence.
		void this.handleServerRequest(message.method, message.id, message.params);
	}

	private async handleServerRequest(method: string, id: number | string, params: unknown): Promise<void> {
		const handler = this.requestHandlers.get(method);
		if (!handler) {
			this.respond(id, undefined, { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${method}` });
			return;
		}
		try {
			const result = await handler(params);
			this.respond(id, result);
		} catch (error) {
			this.respond(id, undefined, { code: JSON_RPC_INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Replies to a server-initiated request. A no-op once the process has exited -- nothing is listening on the other end of a dead pipe. */
	private respond(id: number | string, result: unknown, error?: { code: number; message: string }): void {
		if (this.processExited) return;
		const message = encodeJsonRpcMessage(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
		if (message.byteLength > this.maxMessageBytes) return; // a reply this large cannot be honest; drop rather than desync the stream
		this.child.stdin.write(message);
	}

	/** Subscribes to a server-pushed notification (e.g. textDocument/publishDiagnostics). Returns an unsubscribe function. */
	onNotification(method: string, handler: NotificationHandler): () => void {
		const handlers = this.notificationHandlers.get(method) ?? new Set();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => handlers.delete(handler);
	}

	/**
	 * Registers the single handler for a server-initiated request method (e.g.
	 * client/registerCapability, workspace/configuration). Exactly one handler per
	 * method -- a request needs exactly one reply, unlike a notification's fan-out
	 * Set. Returns an unregister function. A method with no registered handler
	 * answers MethodNotFound automatically.
	 */
	onRequest(method: string, handler: RequestHandler): () => void {
		if (this.requestHandlers.has(method)) throw new DuplicateRequestHandler(method);
		this.requestHandlers.set(method, handler);
		return () => this.requestHandlers.delete(method);
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
