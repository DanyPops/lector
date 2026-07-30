import fetchBuilder, { type RequestInitWithRetry } from "fetch-retry";
import type { ExternalSearchBounds, GithubRepoCandidate, GithubRepoSearchResult } from "../domain/external-search-result.ts";
import type { GithubSearchPort } from "../ports/github-search-port.ts";

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS_PER_PAGE = 100;
const MAX_RETRIES = 10;
const MAX_TIMEOUT_MS = 60 * 1000;

const rawRetryingFetch = fetchBuilder(globalThis.fetch);
type RetryingFetchOptions = RequestInitWithRetry<typeof globalThis.fetch>;

async function retryingFetch(input: URL, options: RetryingFetchOptions): Promise<Response> {
	const result: unknown = await rawRetryingFetch(input, options);
	if (!(result instanceof Response)) throw new TypeError("fetch-retry returned an invalid response");
	return result;
}

export class InvalidGithubSearchRequest extends Error {
	constructor(field: string) {
		super(`invalid GitHub search request: ${field}`);
		this.name = "InvalidGithubSearchRequest";
	}
}

/** Raised for both the primary rate limit (403 + x-ratelimit-remaining: 0) and the secondary rate limit (429 + retry-after) -- both mean the same thing to a caller: back off and retry no sooner than retryAfterSeconds. null means GitHub didn't say when, so the caller must pick its own backoff. */
export class GithubSearchRateLimited extends Error {
	readonly retryAfterSeconds: number | null;

	constructor(retryAfterSeconds: number | null) {
		super(retryAfterSeconds === null ? "GitHub search rate limit exceeded" : `GitHub search rate limit exceeded; retry after ${retryAfterSeconds}s`);
		this.name = "GithubSearchRateLimited";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export class GithubSearchResponseLimitExceeded extends Error {
	readonly limit: number;

	constructor(limit: number) {
		super(`GitHub search response exceeded ${limit} bytes`);
		this.name = "GithubSearchResponseLimitExceeded";
		this.limit = limit;
	}
}

export class GithubSearchRequestFailed extends Error {
	readonly code: "invalid-response" | "request-failed" | "timeout";

	constructor(code: GithubSearchRequestFailed["code"]) {
		super(`GitHub search request failed: ${code}`);
		this.name = "GithubSearchRequestFailed";
		this.code = code;
	}
}

export interface GithubSearchClientOptions {
	readonly token?: () => string | undefined;
	readonly baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function validateText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidGithubSearchRequest(field);
}

function validateBound(value: number, field: string, maximum: number, minimum = 1): void {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new InvalidGithubSearchRequest(field);
}

function repoCandidate(value: unknown): GithubRepoCandidate | null {
	if (!isRecord(value)) return null;
	const fullName = textField(value, "full_name");
	const name = textField(value, "name");
	const owner = isRecord(value.owner) ? textField(value.owner, "login") : null;
	const url = textField(value, "html_url");
	if (fullName === null || name === null || owner === null || url === null) return null;
	return {
		host: "github.com",
		owner,
		repo: name,
		description: textField(value, "description"),
		stars: numberField(value, "stargazers_count"),
		language: textField(value, "language"),
		url,
	};
}

async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit) {
		await discard(response);
		throw new GithubSearchResponseLimitExceeded(limit);
	}
	const chunks: Buffer[] = [];
	let used = 0;
	const body: ReadableStream<Uint8Array> | null = response.body;
	if (body === null) throw new GithubSearchRequestFailed("invalid-response");
	const reader = body.getReader();
	let finished = false;
	while (!finished) {
		const read: unknown = await reader.read();
		if (!isRecord(read) || typeof read.done !== "boolean") throw new GithubSearchRequestFailed("invalid-response");
		if (read.done) {
			finished = true;
			continue;
		}
		if (!(read.value instanceof Uint8Array)) throw new GithubSearchRequestFailed("invalid-response");
		used += read.value.byteLength;
		if (used > limit) {
			await reader.cancel();
			throw new GithubSearchResponseLimitExceeded(limit);
		}
		chunks.push(Buffer.from(read.value));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new GithubSearchRequestFailed("invalid-response");
	}
}

function rateLimitFromHeaders(response: Response): GithubSearchRateLimited | null {
	const retryAfterHeader = response.headers.get("retry-after");
	if (response.status === 429) {
		const retryAfterSeconds = retryAfterHeader === null ? null : Number(retryAfterHeader);
		return new GithubSearchRateLimited(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null);
	}
	if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
		const resetAt = Number(response.headers.get("x-ratelimit-reset"));
		const retryAfterSeconds = Number.isFinite(resetAt) ? Math.max(0, resetAt - Math.floor(Date.now() / 1000)) : null;
		return new GithubSearchRateLimited(retryAfterSeconds);
	}
	return null;
}

export class GithubSearchClient implements GithubSearchPort {
	private readonly token: () => string | undefined;
	private readonly baseUrl: string;

	constructor(options: GithubSearchClientOptions = {}) {
		this.token = options.token ?? (() => process.env.GITHUB_TOKEN);
		this.baseUrl = options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
	}

	async searchRepos(query: string, bounds: ExternalSearchBounds): Promise<GithubRepoSearchResult> {
		validateText(query, "query", 256);
		validateBound(bounds.maxResults, "maxResults", MAX_RESULTS_PER_PAGE);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.maxRetries, "maxRetries", MAX_RETRIES, 0);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
		const url = new URL("/search/repositories", this.baseUrl);
		url.searchParams.set("q", query);
		url.searchParams.set("per_page", String(bounds.maxResults));
		const token = this.token();
		const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
		if (token) headers.authorization = `Bearer ${token}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
		const options: RequestInitWithRetry<typeof globalThis.fetch> = {
			headers,
			retries: bounds.maxRetries,
			retryDelay: (attempt) => Math.min(10 * 2 ** attempt, 100),
			retryOn: async (attempt, error, response) => {
				if (controller.signal.aborted || attempt >= bounds.maxRetries) return false;
				if (response !== null && rateLimitFromHeaders(response) !== null) return false;
				const retryable = error !== null || (response !== null && (response.status === 408 || response.status >= 500));
				if (retryable && response !== null) await discard(response);
				return retryable;
			},
			signal: controller.signal,
		};
		try {
			const response = await retryingFetch(url, options);
			const rateLimited = rateLimitFromHeaders(response);
			if (rateLimited) {
				await discard(response);
				throw rateLimited;
			}
			if (response.status < 200 || response.status >= 300) {
				await discard(response);
				throw new GithubSearchRequestFailed("request-failed");
			}
			const body = await boundedJson(response, bounds.maxResponseBytes);
			if (!isRecord(body) || !Array.isArray(body.items)) throw new GithubSearchRequestFailed("invalid-response");
			const candidates: GithubRepoCandidate[] = [];
			for (const item of body.items) {
				const candidate = repoCandidate(item);
				if (candidate) candidates.push(candidate);
			}
			return { candidates, authenticated: token !== undefined };
		} catch (error) {
			if (
				error instanceof InvalidGithubSearchRequest ||
				error instanceof GithubSearchRateLimited ||
				error instanceof GithubSearchResponseLimitExceeded ||
				error instanceof GithubSearchRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted) throw new GithubSearchRequestFailed("timeout");
			throw new GithubSearchRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}
}
