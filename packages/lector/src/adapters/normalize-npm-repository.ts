import { posix } from "node:path";
import type { NpmRepositoryMetadata } from "../domain/npm-package-metadata.ts";
import type { RepoReference } from "../domain/repo-reference.ts";

export interface NormalizedNpmRepository {
	readonly url: string;
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	readonly directory: string | null;
}

function containsControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function normalizedDirectory(raw: string | null): string | null {
	if (raw === null) return null;
	if (raw.length === 0 || raw.length > 2048 || raw.includes("\\") || containsControlCharacter(raw) || posix.isAbsolute(raw)) return null;
	const normalized = posix.normalize(raw.replace(/^\.\//, "")).replace(/\/$/, "");
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.length === 0) return null;
	return normalized;
}

function shorthand(raw: string): string {
	for (const [prefix, host] of [
		["github:", "github.com"],
		["gitlab:", "gitlab.com"],
		["bitbucket:", "bitbucket.org"],
	] as const) {
		if (raw.startsWith(prefix)) return `https://${host}/${raw.slice(prefix.length)}`;
	}
	if (/^[^/:\s]+\/[^/\s]+(?:\.git)?$/.test(raw)) return `https://github.com/${raw}`;
	return raw;
}

function repositoryUrl(raw: string): URL | null {
	let candidate = shorthand(raw.trim()).replace(/^git\+/, "");
	const scp = candidate.match(/^git@([^:]+):(.+)$/);
	if (scp) candidate = `ssh://git@${scp[1]}/${scp[2]}`;
	if (candidate.startsWith("git://")) candidate = `https://${candidate.slice("git://".length)}`;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}
	if (!["https:", "http:", "ssh:"].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.password) return null;
	if (parsed.username && parsed.username !== "git") return null;
	return parsed;
}

export function normalizeNpmRepository(metadata: NpmRepositoryMetadata): NormalizedNpmRepository | null {
	if (metadata.type !== null && metadata.type.toLowerCase() !== "git") return null;
	const parsed = repositoryUrl(metadata.url);
	if (parsed === null) return null;
	const segments = parsed.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (segments.length !== 2) return null;
	const [owner, repo] = segments;
	if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") return null;
	const directory = normalizedDirectory(metadata.directory);
	if (metadata.directory !== null && directory === null) return null;
	const host = parsed.hostname.toLowerCase();
	return { url: `https://${host}/${owner}/${repo}.git`, host, owner, repo, directory };
}

export function npmRepositoryReference(repository: NormalizedNpmRepository, ref: string): RepoReference {
	return { host: repository.host, owner: repository.owner, repo: repository.repo, ref };
}
