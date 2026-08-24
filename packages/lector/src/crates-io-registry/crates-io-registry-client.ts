import fetchBuilder, { type RequestInitWithRetry } from "fetch-retry";
import { BoundedResponseTooLarge, discardResponseBody, isJsonRecord, MalformedBoundedResponse, readBoundedJson } from "../workspace/bounded-response-reader.ts";
import type { CratesIoPackageVersionMetadata, CratesIoRegistryBounds, CratesIoRegistryVersionRequest } from "./crates-io-package-metadata.ts";
import type { CratesIoRegistryPort } from "./port.ts";

export const DEFAULT_CRATES_IO_REGISTRY = "https://crates.io";
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

export class InvalidCratesIoRegistryRequest extends Error {
	constructor(field: string) {
		super(`invalid crates.io registry request: ${field}`);
		this.name = "InvalidCratesIoRegistryRequest";
	}
}

export class CratesIoRegistryResponseLimitExceeded extends Error {
	constructor(
		readonly limit: number,
		readonly observed: number,
	) {
		super(`crates.io registry response exceeded ${limit} bytes`);
		this.name = "CratesIoRegistryResponseLimitExceeded";
	}
}

/** Cargo's own real per-registry credential convention: `CARGO_REGISTRIES_<NAME>_TOKEN`, distinct per configured registry -- never a single shared token name the way npm/PyPI have. */
export class CratesIoAuthenticationRequired extends Error {
	readonly requiredCredentialNames: readonly string[];

	constructor(registryName: string | null) {
		const envVar = registryName ? `CARGO_REGISTRIES_${registryName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN` : "CARGO_REGISTRY_TOKEN";
		super(`crates.io registry authentication required; configure ${envVar}`);
		this.name = "CratesIoAuthenticationRequired";
		this.requiredCredentialNames = [envVar];
	}
}

export class CratesIoCrateNotFound extends Error {
	constructor() {
		super("crate was not found in the registry");
		this.name = "CratesIoCrateNotFound";
	}
}

export class CratesIoVersionNotFound extends Error {
	constructor() {
		super("crate version was not found in the registry");
		this.name = "CratesIoVersionNotFound";
	}
}

export class CratesIoRegistryRequestFailed extends Error {
	readonly code: "invalid-response" | "request-failed" | "timeout";

	constructor(code: CratesIoRegistryRequestFailed["code"]) {
		super(`crates.io registry request failed: ${code}`);
		this.name = "CratesIoRegistryRequestFailed";
		this.code = code;
	}
}

function validateText(value: string, field: string, maxLength: number): void {
	if (value.length === 0 || value.length > maxLength) throw new InvalidCratesIoRegistryRequest(field);
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) throw new InvalidCratesIoRegistryRequest(field);
	}
}

function validateBound(value: number, field: string, maximum: number, allowZero = false): void {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) throw new InvalidCratesIoRegistryRequest(field);
}

function registryUrl(raw: string): URL {
	validateText(raw, "registryUrl", 2048);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new InvalidCratesIoRegistryRequest("registryUrl");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InvalidCratesIoRegistryRequest("registryUrl");
	return parsed;
}

function tokenEnvVar(registryName: string | null): string | null {
	return registryName ? `CARGO_REGISTRIES_${registryName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN` : null;
}

function textField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
	try {
		return await readBoundedJson(response, limit);
	} catch (error) {
		if (error instanceof BoundedResponseTooLarge) throw new CratesIoRegistryResponseLimitExceeded(error.limit, error.observed);
		if (error instanceof MalformedBoundedResponse) throw new CratesIoRegistryRequestFailed("invalid-response");
		throw error;
	}
}

/**
 * A real crate-level lookup (`GET /api/v1/crates/<name>`) returns both the crate's own
 * repository field and every published version's own yanked status in one response -- unlike
 * npm/PyPI, no separate per-version request is needed here. Any Cargo-compatible alternate
 * registry (crates.io's own "alternate registries" feature requires implementing this identical
 * web API) is served by the same client, parameterized by its own registryUrl.
 */
export class CratesIoRegistryClient implements CratesIoRegistryPort {
	async fetchVersion(request: CratesIoRegistryVersionRequest, bounds: CratesIoRegistryBounds): Promise<CratesIoPackageVersionMetadata> {
		const registry = registryUrl(request.registryUrl);
		validateText(request.name, "name", 512);
		validateText(request.version, "version", 256);
		validateBound(bounds.maxResponseBytes, "maxResponseBytes", MAX_RESPONSE_BYTES);
		validateBound(bounds.maxRedirects, "maxRedirects", MAX_REDIRECTS, true);
		validateBound(bounds.maxRetries, "maxRetries", MAX_RETRIES, true);
		validateBound(bounds.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);

		const envVar = tokenEnvVar(request.registryName);
		const token = envVar ? process.env[envVar] : undefined;
		const headers: Record<string, string> = { accept: "application/json", "user-agent": "lector-package-source-resolver (github.com/DanyPops/lector)" };
		if (token) headers.authorization = token;

		const url = new URL(`api/v1/crates/${encodeURIComponent(request.name)}`, registry.toString().replace(/\/?$/, "/"));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), bounds.timeoutMs);
		const options: RetryingFetchOptions = {
			headers,
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
			if (response.status === 401 || response.status === 403) {
				await discardResponseBody(response);
				throw new CratesIoAuthenticationRequired(request.registryName);
			}
			if (response.status === 404) {
				await discardResponseBody(response);
				throw new CratesIoCrateNotFound();
			}
			if (response.status < 200 || response.status >= 300) {
				await discardResponseBody(response);
				throw new CratesIoRegistryRequestFailed("request-failed");
			}
			const parsed = await boundedJson(response, bounds.maxResponseBytes);
			if (!isJsonRecord(parsed) || !isJsonRecord(parsed.crate)) throw new CratesIoRegistryRequestFailed("invalid-response");
			const versions: unknown = parsed.versions;
			if (!Array.isArray(versions)) throw new CratesIoRegistryRequestFailed("invalid-response");
			const name = textField(parsed.crate, "name") ?? request.name;
			const repository = textField(parsed.crate, "repository");
			const versionEntry: unknown = versions.find((entry: unknown) => isJsonRecord(entry) && textField(entry, "num") === request.version);
			if (!isJsonRecord(versionEntry)) throw new CratesIoVersionNotFound();
			return { name, version: request.version, yanked: versionEntry.yanked === true, repository };
		} catch (error) {
			if (
				error instanceof InvalidCratesIoRegistryRequest ||
				error instanceof CratesIoRegistryResponseLimitExceeded ||
				error instanceof CratesIoAuthenticationRequired ||
				error instanceof CratesIoCrateNotFound ||
				error instanceof CratesIoVersionNotFound ||
				error instanceof CratesIoRegistryRequestFailed
			) {
				throw error;
			}
			if (controller.signal.aborted) throw new CratesIoRegistryRequestFailed("timeout");
			throw new CratesIoRegistryRequestFailed("request-failed");
		} finally {
			clearTimeout(timer);
		}
	}
}
