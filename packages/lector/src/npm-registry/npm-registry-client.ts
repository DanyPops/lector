import fetchBuilder, { type RequestInitWithRetry } from "fetch-retry";
import { BoundedResponseTooLarge, discardResponseBody, isJsonRecord, MalformedBoundedResponse, readBoundedJson } from "../adapters/bounded-response-reader.ts";
import type { ExternalSearchBounds, NpmPackageCandidate } from "../domain/external-search-result.ts";
import type { NpmPackageVersionMetadata, NpmRegistryBounds, NpmRegistryVersionRequest, NpmRepositoryMetadata } from "../domain/npm-package-metadata.ts";
import type { NpmRegistryPort } from "./port.ts";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 20;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SEARCH_RESULTS = 250;

const rawRetryingFetch = fetchBuilder(globalThis.fetch);
type RetryingFetchOptions = RequestInitWithRetry<typeof globalThis.fetch>;

async function retryingFetch(input: URL, options: RetryingFetchOptions): Promise<Response> {
	const result: unknown = await rawRetryingFetch(input, options);
	if (!(result instanceof Response)) throw new TypeError("fetch-retry returned an invalid response");
	return result;
}

export class InvalidNpmRegistryRequest extends Error {
	constructor(field: string) {
		super(`invalid npm registry request: ${field}`);
		this.name = "InvalidNpmRegistryRequest";
	}
}

export class NpmRegistryResponseLimitExceeded extends Error {
	readonly limit: number;
	readonly observed: number;

	constructor(limit: number, observed: number) {
		super(`npm registry response exceeded ${limit} bytes`);
		this.name = "NpmRegistryResponseLimitExceeded";
		this.limit = limit;
		this.observed = observed;
	}
}

export class NpmRegistryAuthenticationRequired extends Error {
	readonly requiredCredentialNames = ["NPM_TOKEN"] as const;

	constructor() {
		super("npm registry authentication required; configure NPM_TOKEN");
		this.name = "NpmRegistryAuthenticationRequired";
	}
}

export class NpmPackageNotFound extends Error {
	constructor() {
		super("npm package was not found in the registry");
		this.name = "NpmPackageNotFound";
	}
}

export class NpmVersionNotFound extends Error {
	constructor() {
		super("npm package version was not found in the registry");
		this.name = "NpmVersionNotFound";
	}
}

export class NpmRegistryRequestFailed extends Error {
	readonly code: "invalid-response" | "request-failed" | "timeout";

	constructor(code: NpmRegistryRequestFailed["code"]) {
		super(`npm registry request failed: ${code}`);
		this.name = "NpmRegistryRequestFailed";
		this.code = code;
	}
}

export interface NpmRegistryClientOptions {
	readonly token?: () => string | undefined;
	/** Overrides the base URL search() hits -- only npmjs.org's own registry serves "-/v1/search" today; tests point this at a local fixture server instead of the real registry. */
	readonly searchRegistry?: string;
}

type RegistryFetchOptions = RetryingFetchOptions & {
	readonly headers: Readonly<Record<string, string>>;
};

function textField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function validateText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength || containsControlCharacter(value)) throw new InvalidNpmRegistryRequest(field);
}

function validateBound(value: number, field: string, maximum: number, allowZero = false): void {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) throw new InvalidNpmRegistryRequest(field);
}

function registryUrl(raw: string): URL {
	validateText(raw, "registry", 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new InvalidNpmRegistryRequest("registry");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new InvalidNpmRegistryRequest("registry");
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InvalidNpmRegistryRequest("registry");
	if (parsed.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
		throw new InvalidNpmRegistryRequest("registry must use HTTPS unless it is loopback");
	}
	return parsed;
}

function encodedPackageName(name: string): string {
	validateText(name, "name", 512);
	if (!name.startsWith("@")) return encodeURIComponent(name);
	const separator = name.indexOf("/");
	if (separator < 2 || separator === name.length - 1) throw new InvalidNpmRegistryRequest("name");
	return `${encodeURIComponent(name.slice(0, separator))}%2f${encodeURIComponent(name.slice(separator + 1))}`;
}

function requestUrl(registry: URL, name: string, version?: string): string {
	const base = registry.toString().replace(/\/?$/, "/");
	const suffix = version === undefined ? encodedPackageName(name) : `${encodedPackageName(name)}/${encodeURIComponent(version)}`;
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
		throw new NpmRegistryRequestFailed("invalid-response");
	}
	if (target.protocol !== "https:" && target.protocol !== "http:") throw new NpmRegistryRequestFailed("invalid-response");
	if (target.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(target.hostname)) {
		throw new NpmRegistryRequestFailed("request-failed");
	}
	return target;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function searchCandidate(value: unknown): NpmPackageCandidate | null {
	if (!isJsonRecord(value)) return null;
	const pkg = value.package;
	if (!isJsonRecord(pkg)) return null;
	const name = textField(pkg, "name");
	const version = textField(pkg, "version");
	if (name === null || version === null) return null;
	const links = isJsonRecord(pkg.links) ? pkg.links : null;
	const score = isJsonRecord(value.score) ? numberField(value.score, "final") : null;
	return {
		name,
		version,
		description: textField(pkg, "description"),
		repositoryUrl: links === null ? null : textField(links, "repository"),
		score: score ?? 0,
	};
}

function searchCandidates(value: unknown): readonly NpmPackageCandidate[] {
	if (!isJsonRecord(value) || !Array.isArray(value.objects)) throw new NpmRegistryRequestFailed("invalid-response");
	const candidates: NpmPackageCandidate[] = [];
	for (const entry of value.objects) {
		const candidate = searchCandidate(entry);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

function repositoryMetadata(value: unknown): NpmRepositoryMetadata | null {
	if (typeof value === "string" && value.length > 0) return { type: null, url: value, directory: null };
	if (!isJsonRecord(value)) return null;
	const url = textField(value, "url");
	if (url === null) return null;
	return { type: textField(value, "type"), url, directory: textField(value, "directory") };
}

function packageMetadata(value: unknown): NpmPackageVersionMetadata {
	if (!isJsonRecord(value)) throw new NpmRegistryRequestFailed("invalid-response");
	const name = textField(value, "name");
	const version = textField(value, "version");
	if (name === null || version === null) throw new NpmRegistryRequestFailed("invalid-response");
	const dist = isJsonRecord(value.dist) ? value.dist : null;
	return {
		name,
		version,
		repository: repositoryMetadata(value.repository),
		gitHead: textField(value, "gitHead"),
		integrity: dist === null ? null : textField(dist, "integrity"),
	};
}

/** Translates the shared bounded-reader's generic errors into this adapter's own public error contract, preserving its existing NpmRegistryResponseLimitExceeded/NpmRegistryRequestFailed shape unchanged. */
async function boundedJson(response: Response, budget: { used: number }, limit: number): Promise<unknown> {
	try {
		return await readBoundedJson(response, limit, budget);
	} catch (error) {
		if (error instanceof BoundedResponseTooLarge) throw new NpmRegistryResponseLimitExceeded(error.limit, error.observed);
		if (error instanceof MalformedBoundedResponse) throw new NpmRegistryRequestFailed("invalid-response");
		throw error;
	}
}

export class NpmRegistryClient implements NpmRegistryPort {
	private readonly token: () => string | undefined;
	private readonly searchRegistry: string;

	constructor(options: NpmRegistryClientOptions = {}) {
		this.token = options.token ?? (() => process.env.NPM_TOKEN);
		this.searchRegistry = options.searchRegistry ?? DEFAULT_NPM_REGISTRY;
	}

	private async fetchFollowingRedirects(url: string, options: RegistryFetchOptions, bounds: NpmRegistryBounds, deadline: number): Promise<Response> {
		let current = new URL(url);
		let headers = { ...options.headers };
		for (let redirects = 0; ; redirects++) {
			if (Date.now() >= deadline) throw new NpmRegistryRequestFailed("timeout");
			const response = await retryingFetch(current, { ...options, headers, redirect: "manual" });
			if (!isRedirect(response.status)) return response;
			await discardResponseBody(response);
			if (redirects >= bounds.maxRedirects) throw new NpmRegistryRequestFailed("request-failed");
			const location = response.headers.get("location");
			if (location === null) throw new NpmRegistryRequestFailed("invalid-response");
			const target = safeRedirectUrl(location, current);
			if (target.origin !== current.origin) {
				headers = { ...headers };
				delete headers.authorization;
			}
			current = target;
		}
	}

	async search(query: string, bounds: ExternalSearchBounds): Promise<readonly NpmPackageCandidate[]> {
		validateText(query, "query", 256);
		validateBound(bounds.maxResults, "maxResults", MAX_SEARCH_RESULTS);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.maxRetries, "maxRetries", MAX_RETRIES, true);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
		const registry = registryUrl(this.searchRegistry);
		const url = new URL(`${registry.toString().replace(/\/?$/, "/")}-/v1/search`);
		url.searchParams.set("text", query);
		url.searchParams.set("size", String(bounds.maxResults));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
		const options: RegistryFetchOptions = {
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
		const budget = { used: 0 };
		try {
			const response = await retryingFetch(url, options);
			if (response.status < 200 || response.status >= 300) {
				await discardResponseBody(response);
				throw new NpmRegistryRequestFailed("request-failed");
			}
			return searchCandidates(await boundedJson(response, budget, bounds.maxResponseBytes));
		} catch (error) {
			if (error instanceof InvalidNpmRegistryRequest || error instanceof NpmRegistryResponseLimitExceeded || error instanceof NpmRegistryRequestFailed) {
				throw error;
			}
			if (controller.signal.aborted) throw new NpmRegistryRequestFailed("timeout");
			throw new NpmRegistryRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}

	async fetchVersion(request: NpmRegistryVersionRequest, bounds: NpmRegistryBounds): Promise<NpmPackageVersionMetadata> {
		const registry = registryUrl(request.registry || DEFAULT_NPM_REGISTRY);
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
				throw new NpmRegistryAuthenticationRequired();
			}
			if (response.status === 404) {
				await discardResponseBody(response);
				const packageResponse = await this.fetchFollowingRedirects(requestUrl(registry, request.name), options, bounds, deadline);
				await discardResponseBody(packageResponse);
				if (packageResponse.status === 401 || packageResponse.status === 403) throw new NpmRegistryAuthenticationRequired();
				if (packageResponse.status === 404) throw new NpmPackageNotFound();
				if (packageResponse.status >= 200 && packageResponse.status < 300) throw new NpmVersionNotFound();
				throw new NpmRegistryRequestFailed("request-failed");
			}
			if (response.status < 200 || response.status >= 300) {
				await discardResponseBody(response);
				throw new NpmRegistryRequestFailed("request-failed");
			}
			return packageMetadata(await boundedJson(response, budget, bounds.maxResponseBytes));
		} catch (error) {
			if (
				error instanceof InvalidNpmRegistryRequest ||
				error instanceof NpmRegistryResponseLimitExceeded ||
				error instanceof NpmRegistryAuthenticationRequired ||
				error instanceof NpmPackageNotFound ||
				error instanceof NpmVersionNotFound ||
				error instanceof NpmRegistryRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted || Date.now() >= deadline) throw new NpmRegistryRequestFailed("timeout");
			throw new NpmRegistryRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}
}
