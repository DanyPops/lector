import fetchBuilder, { type RequestInitWithRetry } from "fetch-retry";
import { BoundedResponseTooLarge, discardResponseBody, isJsonRecord, MalformedBoundedResponse, readBoundedJson } from "../workspace/bounded-response-reader.ts";
import type { PypiRegistryPort } from "./port.ts";
import type { PypiPackageVersionMetadata, PypiRegistryBounds, PypiRegistryVersionRequest } from "./pypi-package-metadata.ts";

export const DEFAULT_PYPI_REGISTRY = "https://pypi.org";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 20;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

const rawRetryingFetch = fetchBuilder(globalThis.fetch);
type RetryingFetchOptions = RequestInitWithRetry<typeof globalThis.fetch>;

async function retryingFetch(input: URL, options: RetryingFetchOptions): Promise<Response> {
	const result: unknown = await rawRetryingFetch(input, options);
	if (!(result instanceof Response)) throw new TypeError("fetch-retry returned an invalid response");
	return result;
}

export class InvalidPypiRegistryRequest extends Error {
	constructor(field: string) {
		super(`invalid PyPI registry request: ${field}`);
		this.name = "InvalidPypiRegistryRequest";
	}
}

export class PypiRegistryResponseLimitExceeded extends Error {
	readonly limit: number;
	readonly observed: number;

	constructor(limit: number, observed: number) {
		super(`PyPI registry response exceeded ${limit} bytes`);
		this.name = "PypiRegistryResponseLimitExceeded";
		this.limit = limit;
		this.observed = observed;
	}
}

/** PyPI's own public registry never requires this; a private, PyPI-JSON-API-compatible index configured via `registry` might. PYPI_TOKEN is this project's own modeled credential name, not a PyPI standard -- PyPI itself has no single canonical auth-token env var the way npm does. */
export class PypiRegistryAuthenticationRequired extends Error {
	readonly requiredCredentialNames = ["PYPI_TOKEN"] as const;

	constructor() {
		super("PyPI registry authentication required; configure PYPI_TOKEN");
		this.name = "PypiRegistryAuthenticationRequired";
	}
}

export class PypiPackageNotFound extends Error {
	constructor() {
		super("PyPI package was not found in the registry");
		this.name = "PypiPackageNotFound";
	}
}

export class PypiVersionNotFound extends Error {
	constructor() {
		super("PyPI package version was not found in the registry");
		this.name = "PypiVersionNotFound";
	}
}

export class PypiRegistryRequestFailed extends Error {
	readonly code: "invalid-response" | "request-failed" | "timeout";

	constructor(code: PypiRegistryRequestFailed["code"]) {
		super(`PyPI registry request failed: ${code}`);
		this.name = "PypiRegistryRequestFailed";
		this.code = code;
	}
}

export interface PypiRegistryClientOptions {
	readonly token?: () => string | undefined;
}

type RegistryFetchOptions = RetryingFetchOptions & {
	readonly headers: Readonly<Record<string, string>>;
};

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function validateText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength || containsControlCharacter(value)) throw new InvalidPypiRegistryRequest(field);
}

function validateBound(value: number, field: string, maximum: number, allowZero = false): void {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) throw new InvalidPypiRegistryRequest(field);
}

function registryUrl(raw: string): URL {
	validateText(raw, "registry", 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new InvalidPypiRegistryRequest("registry");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new InvalidPypiRegistryRequest("registry");
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InvalidPypiRegistryRequest("registry");
	if (parsed.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
		throw new InvalidPypiRegistryRequest("registry must use HTTPS unless it is loopback");
	}
	return parsed;
}

function requestUrl(registry: URL, name: string, version?: string): string {
	validateText(name, "name", 512);
	const base = registry.toString().replace(/\/?$/, "/");
	const suffix = version === undefined ? `pypi/${encodeURIComponent(name)}/json` : `pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
	return new URL(suffix, base).toString();
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function safeRedirectUrl(raw: string, current: URL): URL {
	let target: URL;
	try {
		target = new URL(raw, current);
	} catch {
		throw new PypiRegistryRequestFailed("invalid-response");
	}
	if (target.protocol !== "https:" && target.protocol !== "http:") throw new PypiRegistryRequestFailed("invalid-response");
	if (target.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(target.hostname)) {
		throw new PypiRegistryRequestFailed("request-failed");
	}
	return target;
}

function textField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function projectUrls(value: unknown): Record<string, string> | null {
	if (!isJsonRecord(value)) return null;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" && entry.length > 0) result[key] = entry;
	return Object.keys(result).length > 0 ? result : null;
}

function packageMetadata(value: unknown): PypiPackageVersionMetadata {
	if (!isJsonRecord(value) || !isJsonRecord(value.info)) throw new PypiRegistryRequestFailed("invalid-response");
	const name = textField(value.info, "name");
	const version = textField(value.info, "version");
	if (name === null || version === null) throw new PypiRegistryRequestFailed("invalid-response");
	return { name, version, projectUrls: projectUrls(value.info.project_urls) };
}

/** Translates the shared bounded-reader's generic errors into this adapter's own public error contract, preserving its existing PypiRegistryResponseLimitExceeded/PypiRegistryRequestFailed shape unchanged. */
async function boundedJson(response: Response, budget: { used: number }, limit: number): Promise<unknown> {
	try {
		return await readBoundedJson(response, limit, budget);
	} catch (error) {
		if (error instanceof BoundedResponseTooLarge) throw new PypiRegistryResponseLimitExceeded(error.limit, error.observed);
		if (error instanceof MalformedBoundedResponse) throw new PypiRegistryRequestFailed("invalid-response");
		throw error;
	}
}

export class PypiRegistryClient implements PypiRegistryPort {
	private readonly token: () => string | undefined;

	constructor(options: PypiRegistryClientOptions = {}) {
		this.token = options.token ?? (() => process.env.PYPI_TOKEN);
	}

	private async fetchFollowingRedirects(url: string, options: RegistryFetchOptions, bounds: PypiRegistryBounds, deadline: number): Promise<Response> {
		let current = new URL(url);
		let headers = { ...options.headers };
		for (let redirects = 0; ; redirects++) {
			if (Date.now() >= deadline) throw new PypiRegistryRequestFailed("timeout");
			const response = await retryingFetch(current, { ...options, headers, redirect: "manual" });
			if (!isRedirect(response.status)) return response;
			await discardResponseBody(response);
			if (redirects >= bounds.maxRedirects) throw new PypiRegistryRequestFailed("request-failed");
			const location = response.headers.get("location");
			if (location === null) throw new PypiRegistryRequestFailed("invalid-response");
			const target = safeRedirectUrl(location, current);
			if (target.origin !== current.origin) {
				headers = { ...headers };
				delete headers.authorization;
			}
			current = target;
		}
	}

	async fetchVersion(request: PypiRegistryVersionRequest, bounds: PypiRegistryBounds): Promise<PypiPackageVersionMetadata> {
		const registry = registryUrl(request.registry || DEFAULT_PYPI_REGISTRY);
		validateText(request.version, "version", 256);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.maxRedirects, "maxRedirects", MAX_REDIRECTS, true);
		validateBound(bounds.maxRetries, "maxRetries", MAX_RETRIES, true);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
		const token = this.token();
		const headers: Record<string, string> = { accept: "application/json" };
		if (token) headers.authorization = `Bearer ${token}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
		const options: RegistryFetchOptions = {
			headers,
			redirect: "manual",
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
		const deadline = Date.now() + bounds.timeoutMs;
		const budget = { used: 0 };
		try {
			const response = await this.fetchFollowingRedirects(requestUrl(registry, request.name, request.version), options, bounds, deadline);
			if (response.status === 401 || response.status === 403) {
				await discardResponseBody(response);
				throw new PypiRegistryAuthenticationRequired();
			}
			if (response.status === 404) {
				await discardResponseBody(response);
				const packageResponse = await this.fetchFollowingRedirects(requestUrl(registry, request.name), options, bounds, deadline);
				await discardResponseBody(packageResponse);
				if (packageResponse.status === 401 || packageResponse.status === 403) throw new PypiRegistryAuthenticationRequired();
				if (packageResponse.status === 404) throw new PypiPackageNotFound();
				if (packageResponse.status >= 200 && packageResponse.status < 300) throw new PypiVersionNotFound();
				throw new PypiRegistryRequestFailed("request-failed");
			}
			if (response.status < 200 || response.status >= 300) {
				await discardResponseBody(response);
				throw new PypiRegistryRequestFailed("request-failed");
			}
			return packageMetadata(await boundedJson(response, budget, bounds.maxResponseBytes));
		} catch (error) {
			if (
				error instanceof InvalidPypiRegistryRequest ||
				error instanceof PypiRegistryResponseLimitExceeded ||
				error instanceof PypiRegistryAuthenticationRequired ||
				error instanceof PypiPackageNotFound ||
				error instanceof PypiVersionNotFound ||
				error instanceof PypiRegistryRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted || Date.now() >= deadline) throw new PypiRegistryRequestFailed("timeout");
			throw new PypiRegistryRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}
}
