import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePypiRepository, pypiRepositoryReference } from "../../src/pypi-registry/normalize-pypi-repository.ts";

const REGISTRY_ROOT = join(import.meta.dirname, "../../test/fixtures/python-reference/registry");

function projectUrlsOf(fixtureFile: string): Record<string, string> | null {
	const info = (JSON.parse(readFileSync(join(REGISTRY_ROOT, fixtureFile), "utf8")) as { info: { project_urls: Record<string, string> | null } }).info;
	return info.project_urls;
}

describe("normalizePypiRepository", () => {
	it("normalizes a real GitHub Source URL from the exact fixture registry response", () => {
		expect(normalizePypiRepository(projectUrlsOf("exact.json"))).toEqual({
			url: "https://github.com/psf/requests.git",
			host: "github.com",
			owner: "psf",
			repo: "requests",
		});
	});

	it("returns null when the real fixture has no project_urls at all", () => {
		expect(normalizePypiRepository(projectUrlsOf("missing-repository.json"))).toBeNull();
	});

	it("normalizes a real non-GitHub private index Source URL -- any owner/repo-shaped host is accepted, not just known public hosts", () => {
		expect(normalizePypiRepository(projectUrlsOf("private.json"))).toEqual({
			url: "https://git.internal.example/team/internal-private-package.git",
			host: "git.internal.example",
			owner: "team",
			repo: "internal-private-package",
		});
	});

	it("normalizes a Source URL with no .git suffix", () => {
		expect(normalizePypiRepository(projectUrlsOf("mismatched-tag.json"))).toEqual({
			url: "https://github.com/example/mismatched-tag-package.git",
			host: "github.com",
			owner: "example",
			repo: "mismatched-tag-package",
		});
	});

	it("prefers a 'Source Code'/'Source'/'Repository' label over an unrelated one", () => {
		expect(normalizePypiRepository({ Documentation: "https://widgets.readthedocs.io", Source: "https://github.com/acme/widgets" })).toEqual({
			url: "https://github.com/acme/widgets.git",
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	it("falls back to scanning every project_urls value when no recognized label matches, catching a Homepage that already points at the repo", () => {
		expect(normalizePypiRepository({ Homepage: "https://github.com/acme/widgets" })).toEqual({
			url: "https://github.com/acme/widgets.git",
			host: "github.com",
			owner: "acme",
			repo: "widgets",
		});
	});

	it("returns null when nothing in project_urls has an owner/repo-shaped path", () => {
		expect(normalizePypiRepository({ Homepage: "https://widgets.example.com", Documentation: "https://docs.example.com" })).toBeNull();
	});

	it("returns null for a URL with too many path segments to represent as a single owner/repo pair", () => {
		expect(normalizePypiRepository({ Source: "https://gitlab.com/acme/team/widgets" })).toBeNull();
	});
});

describe("pypiRepositoryReference", () => {
	it("builds a RepoReference from a normalized repository and a ref", () => {
		const repository = normalizePypiRepository({ Source: "https://github.com/psf/requests" });
		expect(repository && pypiRepositoryReference(repository, "v2.31.0")).toEqual({ host: "github.com", owner: "psf", repo: "requests", ref: "v2.31.0" });
	});
});
