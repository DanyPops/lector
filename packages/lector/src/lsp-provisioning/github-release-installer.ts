import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fetchBuilder, { type RequestInitWithRetry } from "fetch-retry";
import { discardResponseBody, readBoundedJson } from "../adapters/bounded-response-reader.ts";
import type { GithubReleaseLanguageServerSource } from "../domain/language-server-package-spec.ts";
import type { LspPlatform } from "../domain/lsp-platform.ts";
import { runBoundedSubprocess } from "./bounded-subprocess.ts";
import type { ResolvedInstall } from "./resolved-install.ts";

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const MAX_RELEASE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 30_000;

const rawRetryingFetch = fetchBuilder(globalThis.fetch);
type RetryingFetchOptions = RequestInitWithRetry<typeof globalThis.fetch>;

async function boundedFetch(input: URL, options: RetryingFetchOptions): Promise<Response> {
	const result: unknown = await rawRetryingFetch(input, options);
	if (!(result instanceof Response)) throw new TypeError("fetch-retry returned an invalid response");
	return result;
}

export class GithubReleaseNotFound extends Error {
	constructor(repo: string, tag: string | undefined) {
		super(`no ${tag ?? "latest"} release found for ${repo}`);
		this.name = "GithubReleaseNotFound";
	}
}

export class GithubReleaseAssetUnavailable extends Error {
	constructor(
		readonly repo: string,
		readonly platform: LspPlatform,
	) {
		super(`no release asset for ${repo} matches ${platform.os}/${platform.arch}${platform.libc ? `/${platform.libc}` : ""}`);
		this.name = "GithubReleaseAssetUnavailable";
	}
}

export class GithubReleaseRequestFailed extends Error {
	constructor(readonly detail: string) {
		super(`GitHub release request failed: ${detail}`);
		this.name = "GithubReleaseRequestFailed";
	}
}

export class UnsupportedReleaseArchiveFormat extends Error {
	constructor(readonly assetName: string) {
		super(`unsupported release archive format: ${assetName} (only .tar.gz/.tgz, .zip, .gz, and a bare binary asset are supported)`);
		this.name = "UnsupportedReleaseArchiveFormat";
	}
}

interface GithubReleaseAsset {
	readonly name: string;
	readonly browser_download_url: string;
}

interface GithubReleaseResponse {
	readonly tag_name: string;
	readonly assets: readonly GithubReleaseAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isGithubReleaseResponse(value: unknown): value is GithubReleaseResponse {
	return isRecord(value) && typeof value.tag_name === "string" && Array.isArray(value.assets);
}

interface ArchiveExtraction {
	readonly command: string;
	readonly args: readonly string[];
}

function archiveExtraction(assetName: string, archivePath: string, stagingDir: string): ArchiveExtraction | undefined {
	if (assetName.endsWith(".tar.gz") || assetName.endsWith(".tgz")) return { command: "tar", args: ["-xzf", archivePath, "-C", stagingDir] };
	if (assetName.endsWith(".zip")) return { command: "unzip", args: ["-q", archivePath, "-d", stagingDir] };
	if (assetName.endsWith(".gz")) return { command: "gzip", args: ["-d", archivePath] };
	return undefined;
}

export interface GithubReleaseInstallerOptions {
	readonly apiBaseUrl?: string;
	readonly token?: () => string | undefined;
	readonly timeoutMs?: number;
	readonly extractTimeoutMs?: number;
}

async function fetchRelease(repo: string, tag: string | undefined, options: GithubReleaseInstallerOptions): Promise<GithubReleaseResponse> {
	const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
	const url = new URL(`${apiBaseUrl.replace(/\/?$/, "/")}repos/${repo}/releases/${tag ? `tags/${tag}` : "latest"}`);
	const token = options.token?.();
	const headers: Record<string, string> = { accept: "application/vnd.github+json" };
	if (token) headers.authorization = `Bearer ${token}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await boundedFetch(url, { headers, signal: controller.signal });
		if (response.status === 404) {
			await discardResponseBody(response);
			throw new GithubReleaseNotFound(repo, tag);
		}
		if (response.status < 200 || response.status >= 300) {
			await discardResponseBody(response);
			throw new GithubReleaseRequestFailed(`HTTP ${response.status}`);
		}
		const json = await readBoundedJson(response, MAX_RELEASE_JSON_BYTES);
		if (!isGithubReleaseResponse(json)) throw new GithubReleaseRequestFailed("malformed release response");
		return json;
	} catch (error) {
		if (error instanceof GithubReleaseNotFound || error instanceof GithubReleaseRequestFailed) throw error;
		if (controller.signal.aborted) throw new GithubReleaseRequestFailed("timeout");
		throw new GithubReleaseRequestFailed(error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timer);
	}
}

async function downloadAsset(url: string, timeoutMs: number): Promise<Buffer> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await boundedFetch(new URL(url), { signal: controller.signal });
		if (response.status < 200 || response.status >= 300) {
			await discardResponseBody(response);
			throw new GithubReleaseRequestFailed(`asset download HTTP ${response.status}`);
		}
		const arrayBuffer = await response.arrayBuffer();
		if (arrayBuffer.byteLength > MAX_ASSET_BYTES) throw new GithubReleaseRequestFailed(`asset exceeded ${MAX_ASSET_BYTES} bytes`);
		return Buffer.from(arrayBuffer);
	} catch (error) {
		if (error instanceof GithubReleaseRequestFailed) throw error;
		if (controller.signal.aborted) throw new GithubReleaseRequestFailed("timeout");
		throw new GithubReleaseRequestFailed(error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolves the release for `source.tag` (or latest), matches its own platform-specific asset via
 * `source.assetName`, downloads it, and extracts it into the staging directory. Supports
 * `.tar.gz`/`.tgz`, `.zip`, and single-binary `.gz` assets through bounded system extractors,
 * plus bare binaries. Extractor failures remain typed provisioning failures and staging cleanup
 * keeps partial installs unreachable.
 */
export async function resolveGithubReleaseInstall(
	source: GithubReleaseLanguageServerSource,
	platform: LspPlatform,
	options: GithubReleaseInstallerOptions = {},
): Promise<ResolvedInstall> {
	const release = await fetchRelease(source.repo, source.tag, options);
	const assetName = source.assetName(platform, release.tag_name);
	if (!assetName) throw new GithubReleaseAssetUnavailable(source.repo, platform);
	const asset = release.assets.find((candidate) => candidate.name === assetName);
	if (!asset) throw new GithubReleaseAssetUnavailable(source.repo, platform);

	return {
		resolvedVersion: release.tag_name,
		install: async (stagingDir: string): Promise<string> => {
			const bytes = await downloadAsset(asset.browser_download_url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const binPath = source.binPathInArchive(platform, release.tag_name);
			const singleGzip = assetName.endsWith(".gz") && !assetName.endsWith(".tar.gz");
			const archivePath = join(stagingDir, singleGzip ? `${binPath}.gz` : assetName);
			const extraction = archiveExtraction(assetName, archivePath, stagingDir);
			if (extraction) {
				mkdirSync(dirname(archivePath), { recursive: true });
				writeFileSync(archivePath, bytes);
				const result = await runBoundedSubprocess(extraction.command, extraction.args, {
					timeoutMs: options.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS,
				});
				if (result.code !== 0) {
					throw new GithubReleaseRequestFailed(`${extraction.command} extraction failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
				}
				rmSync(archivePath, { force: true });
				chmodSync(join(stagingDir, binPath), 0o755);
				return binPath;
			}
			if (!assetName.includes(".") || assetName.endsWith(".exe")) {
				const fullPath = join(stagingDir, binPath);
				mkdirSync(dirname(fullPath), { recursive: true });
				writeFileSync(fullPath, bytes, { mode: 0o755 });
				chmodSync(fullPath, 0o755);
				return binPath;
			}
			throw new UnsupportedReleaseArchiveFormat(assetName);
		},
	};
}
