import { createParser, type EventSourceMessage } from "eventsource-parser";
import type {
	ExternalSearchBounds,
	SourcegraphCodeCandidate,
	SourcegraphCodeSearchResult,
	SourcegraphLineMatch,
	SourcegraphSearchStopReason,
} from "../external-search/external-search-result.ts";
import type { SourcegraphSearchPort } from "./port.ts";

/** Public, unauthenticated sourcegraph.com only -- a private/self-hosted instance is explicitly out of scope for this client (see the task's own "explicitly out of scope" section). */
export const DEFAULT_SOURCEGRAPH_BASE_URL = "https://sourcegraph.com";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS = 500;
const MAX_TIMEOUT_MS = 60 * 1000;

export class InvalidSourcegraphSearchRequest extends Error {
	constructor(field: string) {
		super(`invalid Sourcegraph search request: ${field}`);
		this.name = "InvalidSourcegraphSearchRequest";
	}
}

export class SourcegraphSearchResponseLimitExceeded extends Error {
	readonly limit: number;

	constructor(limit: number) {
		super(`Sourcegraph search stream exceeded ${limit} bytes`);
		this.name = "SourcegraphSearchResponseLimitExceeded";
		this.limit = limit;
	}
}

export class SourcegraphSearchRequestFailed extends Error {
	readonly code: "invalid-response" | "request-failed" | "timeout" | "alert";

	constructor(code: SourcegraphSearchRequestFailed["code"]) {
		super(`Sourcegraph search request failed: ${code}`);
		this.name = "SourcegraphSearchRequestFailed";
		this.code = code;
	}
}

export interface SourcegraphSearchClientOptions {
	readonly baseUrl?: string;
	/** Maximum additional collection time after the first useful candidate. Defaults to 1s. */
	readonly partialResultGraceMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidSourcegraphSearchRequest(field);
}

function validateBound(value: number, field: string, maximum: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new InvalidSourcegraphSearchRequest(field);
}

function lineMatchOf(value: unknown): SourcegraphLineMatch | null {
	if (!isRecord(value)) return null;
	const lineNumber = value.lineNumber;
	const line = value.line;
	if (typeof lineNumber !== "number" || typeof line !== "string") return null;
	return { line: lineNumber, preview: line };
}

function codeCandidate(value: unknown): SourcegraphCodeCandidate | null {
	if (!isRecord(value) || value.type !== "content") return null;
	const repository = value.repository;
	const path = value.path;
	if (typeof repository !== "string" || typeof path !== "string") return null;
	const rawMatches = Array.isArray(value.lineMatches) ? value.lineMatches : [];
	const lineMatches: SourcegraphLineMatch[] = [];
	for (const rawMatch of rawMatches) {
		const match = lineMatchOf(rawMatch);
		if (match) lineMatches.push(match);
	}
	return { repository, path, lineMatches, url: `${DEFAULT_SOURCEGRAPH_BASE_URL}/${repository}/-/blob/${path}` };
}

async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

export class SourcegraphSearchClient implements SourcegraphSearchPort {
	private readonly baseUrl: string;
	private readonly partialResultGraceMs: number;

	constructor(options: SourcegraphSearchClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? DEFAULT_SOURCEGRAPH_BASE_URL;
		this.partialResultGraceMs = options.partialResultGraceMs ?? 1_000;
		validateBound(this.partialResultGraceMs, "partialResultGraceMs", 5_000);
	}

	async searchCode(query: string, bounds: ExternalSearchBounds): Promise<SourcegraphCodeSearchResult> {
		validateText(query, "query", 256);
		validateBound(bounds.maxResults, "maxResults", MAX_RESULTS);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);

		const url = new URL("/.api/search/stream", this.baseUrl);
		url.searchParams.set("q", query);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
		let partialTimer: ReturnType<typeof setTimeout> | undefined;
		const candidates: SourcegraphCodeCandidate[] = [];
		const partialResultGraceMs = this.partialResultGraceMs;
		const state: { done: boolean; stopReason?: SourcegraphSearchStopReason } = { done: false };
		let used = 0;
		const outcome = (stopReason?: SourcegraphSearchStopReason): SourcegraphCodeSearchResult => ({
			candidates,
			completeness: stopReason === undefined ? "complete" : "partial",
			truncated: stopReason !== undefined,
			...(stopReason ? { stopReason } : {}),
			bytesRead: used,
		});
		try {
			const response = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
			if (response.status < 200 || response.status >= 300) {
				await discard(response);
				throw new SourcegraphSearchRequestFailed("request-failed");
			}
			const body: ReadableStream<Uint8Array> | null = response.body;
			if (body === null) throw new SourcegraphSearchRequestFailed("invalid-response");
			const reader = body.getReader();
			const decoder = new TextDecoder();

			// Real SSE parsing (generic field/comment handling, exact per-spec whitespace trimming,
			// multi-line data joining) rather than a hand-rolled "event:"/"data:" line splitter --
			// this API's own event/done/alert shape is the only Sourcegraph-specific part. feed() is
			// synchronous, so throwing from onEvent propagates straight out to the catch below.
			const parser = createParser({
				onEvent(event: EventSourceMessage) {
					if (state.done) return;
					if (event.event === "alert") throw new SourcegraphSearchRequestFailed("alert");
					if (event.event === "done") {
						state.done = true;
						return;
					}
					if (event.event !== "matches") return;
					let items: unknown;
					try {
						items = JSON.parse(event.data);
					} catch {
						throw new SourcegraphSearchRequestFailed("invalid-response");
					}
					if (!Array.isArray(items)) throw new SourcegraphSearchRequestFailed("invalid-response");
					for (const item of items) {
						const candidate = codeCandidate(item);
						if (candidate) {
							candidates.push(candidate);
							partialTimer ??= setTimeout(() => controller.abort(), Math.min(bounds.timeoutMs, partialResultGraceMs));
						}
						if (candidates.length >= bounds.maxResults) {
							state.done = true;
							state.stopReason = "max-results";
							return;
						}
					}
				},
			});

			for (;;) {
				const read = await reader.read();
				if (read.done) break;
				used += read.value.byteLength;
				if (used > bounds.maxResponseBytes) {
					await reader.cancel();
					if (candidates.length > 0) return outcome("max-response-bytes");
					throw new SourcegraphSearchResponseLimitExceeded(bounds.maxResponseBytes);
				}
				parser.feed(decoder.decode(read.value, { stream: true }));
				if (state.done) {
					await reader.cancel();
					break;
				}
			}
			return outcome(state.stopReason);
		} catch (error) {
			if (
				error instanceof InvalidSourcegraphSearchRequest ||
				error instanceof SourcegraphSearchResponseLimitExceeded ||
				error instanceof SourcegraphSearchRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted) {
				if (candidates.length > 0) return outcome("deadline");
				throw new SourcegraphSearchRequestFailed("timeout");
			}
			throw new SourcegraphSearchRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
			if (partialTimer !== undefined) clearTimeout(partialTimer);
		}
	}
}
