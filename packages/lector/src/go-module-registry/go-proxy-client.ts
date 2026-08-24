import fetchBuilder, { type RequestInitWithRetry } from "fetch-retry";
import { BoundedResponseTooLarge, discardResponseBody, isJsonRecord, MalformedBoundedResponse, readBoundedJson } from "../workspace/bounded-response-reader.ts";
import { escapeGoModulePath } from "./escape-go-module-path.ts";

export const DEFAULT_GOPROXY = "https://proxy.golang.org";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

const rawRetryingFetch = fetchBuilder(globalThis.fetch);
type RetryingFetchOptions = RequestInitWithRetry<typeof globalThis.fetch>;

async function retryingFetch(input: URL, options: RetryingFetchOptions): Promise<Response> {
	const result: unknown = await rawRetryingFetch(input, options);
	if (!(result instanceof Response)) throw new TypeError("fetch-retry returned an invalid response");
	return result;
}

export interface GoProxyModuleVersionInfo {
	readonly version: string;
}

export interface GoProxyVersionRequest {
	readonly proxyUrl: string;
	readonly modulePath: string;
	readonly version: string;
}

export interface GoProxyBounds {
	readonly maxResponseBytes: number;
	readonly maxRetries: number;
	readonly timeoutMs: number;
}

export class InvalidGoProxyRequest extends Error {
	constructor(field: string) {
		super(`invalid GOPROXY request: ${field}`);
		this.name = "InvalidGoProxyRequest";
	}
}

export class GoProxyResponseLimitExceeded extends Error {
	constructor(
		readonly limit: number,
		readonly observed: number,
	) {
		super(`GOPROXY response exceeded ${limit} bytes`);
		this.name = "GoProxyResponseLimitExceeded";
	}
}

export class GoProxyVersionNotFound extends Error {
	constructor() {
		super("GOPROXY has no record of this module version");
		this.name = "GoProxyVersionNotFound";
	}
}

export class GoProxyRequestFailed extends Error {
	readonly code: "invalid-response" | "request-failed" | "timeout";

	constructor(code: GoProxyRequestFailed["code"]) {
		super(`GOPROXY request failed: ${code}`);
		this.name = "GoProxyRequestFailed";
		this.code = code;
	}
}

function validateText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidGoProxyRequest(field);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) throw new InvalidGoProxyRequest(field);
	}
}

function validateBound(value: number, field: string, maximum: number, allowZero = false): void {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) throw new InvalidGoProxyRequest(field);
}

function proxyUrl(raw: string): URL {
	validateText(raw, "proxyUrl", 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new InvalidGoProxyRequest("proxyUrl");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InvalidGoProxyRequest("proxyUrl");
	return parsed;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
	try {
		return await readBoundedJson(response, limit);
	} catch (error) {
		if (error instanceof BoundedResponseTooLarge) throw new GoProxyResponseLimitExceeded(error.limit, error.observed);
		if (error instanceof MalformedBoundedResponse) throw new GoProxyRequestFailed("invalid-response");
		throw error;
	}
}

/**
 * Confirms a Go module version genuinely exists, per GOPROXY's own real `@v/<version>.info`
 * protocol endpoint -- a bounded existence check, not a full content download. Used as a
 * pre-clone sanity check for a plain module-path resolution, catching a typo'd or unpublished
 * version before ever invoking RepoFetcherPort.
 */
export class GoProxyClient {
	async fetchVersionInfo(request: GoProxyVersionRequest, bounds: GoProxyBounds): Promise<GoProxyModuleVersionInfo> {
		const registry = proxyUrl(request.proxyUrl);
		validateText(request.modulePath, "modulePath", 1024);
		validateText(request.version, "version", 256);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.maxRetries, "maxRetries", MAX_RETRIES, true);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);

		const url = new URL(`${escapeGoModulePath(request.modulePath)}/@v/${encodeURIComponent(request.version)}.info`, registry.toString().replace(/\/?$/, "/"));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
		const options: RetryingFetchOptions = {
			headers: { accept: "application/json" },
			retries: bounds.maxRetries,
			retryDelay: (attempt) => Math.min(10 * 2 ** attempt, 100),
			retryOn: async (attempt, error, response) => {
				if (controller.signal.aborted || attempt >= bounds.maxRetries) return false;
				const retryable = error !== null || (response !== null && (response.status === 408 || response.status === 429 || response.status >= 500));
				if (retryable && response !== null) await discardResponseBody(response);
				return retryable;
			},
			signal: controller.signal,
		};
		try {
			const response = await retryingFetch(url, options);
			if (response.status === 404 || response.status === 410) {
				await discardResponseBody(response);
				throw new GoProxyVersionNotFound();
			}
			if (response.status < 200 || response.status >= 300) {
				await discardResponseBody(response);
				throw new GoProxyRequestFailed("request-failed");
			}
			const parsed = await boundedJson(response, bounds.maxResponseBytes);
			if (!isJsonRecord(parsed) || typeof parsed.Version !== "string" || parsed.Version.length === 0) {
				throw new GoProxyRequestFailed("invalid-response");
			}
			return { version: parsed.Version };
		} catch (error) {
			if (
				error instanceof InvalidGoProxyRequest ||
				error instanceof GoProxyResponseLimitExceeded ||
				error instanceof GoProxyVersionNotFound ||
				error instanceof GoProxyRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted) throw new GoProxyRequestFailed("timeout");
			throw new GoProxyRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}
}
