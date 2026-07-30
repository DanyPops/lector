import type { ExternalSearchBounds, SourcegraphCodeCandidate, SourcegraphLineMatch } from "../domain/external-search-result.ts";
import type { SourcegraphSearchPort } from "../ports/sourcegraph-search-port.ts";

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
	/** No confirmed header convention for sourcegraph.com's own token auth -- unused for v1's public, unauthenticated-only scope. Present so a future private-instance client can extend this one without a breaking constructor change. */
	readonly token?: () => string | undefined;
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

/** One "event: X\ndata: Y" SSE frame, already split from the raw stream on a blank-line boundary. Multiple "data:" lines within one frame are joined with "\n", per the SSE spec -- Sourcegraph's own events are single-line JSON in practice, but this doesn't assume that. */
function parseSseFrame(frame: string): { event: string; data: string } | null {
	let event = "message";
	const dataLines: string[] = [];
	for (const rawLine of frame.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}

export class SourcegraphSearchClient implements SourcegraphSearchPort {
	private readonly baseUrl: string;

	constructor(options: SourcegraphSearchClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? DEFAULT_SOURCEGRAPH_BASE_URL;
	}

	async searchCode(query: string, bounds: ExternalSearchBounds): Promise<readonly SourcegraphCodeCandidate[]> {
		validateText(query, "query", 256);
		validateBound(bounds.maxResults, "maxResults", MAX_RESULTS);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);

		const url = new URL("/.api/search/stream", this.baseUrl);
		url.searchParams.set("q", query);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
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
			let buffer = "";
			let used = 0;
			const candidates: SourcegraphCodeCandidate[] = [];
			frames: for (;;) {
				const read = await reader.read();
				if (read.done) break;
				used += read.value.byteLength;
				if (used > bounds.maxResponseBytes) {
					await reader.cancel();
					throw new SourcegraphSearchResponseLimitExceeded(bounds.maxResponseBytes);
				}
				buffer += decoder.decode(read.value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const parsed = parseSseFrame(frame);
					boundary = buffer.indexOf("\n\n");
					if (!parsed) continue;
					if (parsed.event === "alert") {
						await reader.cancel();
						throw new SourcegraphSearchRequestFailed("alert");
					}
					if (parsed.event === "done") break frames;
					if (parsed.event !== "matches") continue;
					let items: unknown;
					try {
						items = JSON.parse(parsed.data);
					} catch {
						throw new SourcegraphSearchRequestFailed("invalid-response");
					}
					if (!Array.isArray(items)) throw new SourcegraphSearchRequestFailed("invalid-response");
					for (const item of items) {
						const candidate = codeCandidate(item);
						if (candidate) candidates.push(candidate);
						if (candidates.length >= bounds.maxResults) {
							await reader.cancel();
							break frames;
						}
					}
				}
			}
			return candidates;
		} catch (error) {
			if (
				error instanceof InvalidSourcegraphSearchRequest ||
				error instanceof SourcegraphSearchResponseLimitExceeded ||
				error instanceof SourcegraphSearchRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted) throw new SourcegraphSearchRequestFailed("timeout");
			throw new SourcegraphSearchRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}
}
