import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { normalizeNpmRepository } from "../../src/adapters/normalize-npm-repository.ts";
import { NpmPackageSourceResolver } from "../../src/adapters/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "../../src/adapters/npm-registry-client.ts";
import type { PackageSourceBounds, PackageSourceRequest } from "../../src/domain/package-source.ts";
import { NpmLockfileVersionResolver } from "../../src/installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import { GitRepoFetcher } from "../../src/repo-fetcher/git-repo-fetcher.ts";

const BOUNDS: PackageSourceBounds = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxManifestNesting: 64,
	maxWorkspaces: 100,
	maxDiagnostics: 20,
	maxRegistryResponseBytes: 1_000_000,
	maxRedirects: 3,
	maxRetries: 1,
	maxCloneBytes: 10_000_000,
	maxCacheBytes: 50_000_000,
	maxCandidates: 20,
	timeoutMs: 10_000,
};

const roots: string[] = [];
const servers: Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sourceRepository(identity: { name?: string; version?: string } = {}): { root: string; commit: string } {
	const root = temp("lector-npm-source-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	mkdirSync(join(root, "packages/widget"), { recursive: true });
	writeFileSync(
		join(root, "packages/widget/package.json"),
		JSON.stringify({ name: identity.name ?? "@scope/widget", version: identity.version ?? "1.2.3", type: "module" }),
	);
	writeFileSync(join(root, "packages/widget/index.ts"), "export const widget = 1;\n");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "release");
	git(root, "tag", "v1.2.3");
	return { root, commit: git(root, "rev-parse", "HEAD") };
}

function projectLock(versions = ["1.2.3"]): string {
	const root = temp("lector-npm-source-project-");
	const packages = Object.fromEntries(
		versions.map((version, index) => [index === 0 ? "node_modules/@scope/widget" : `node_modules/parent-${index}/node_modules/@scope/widget`, { version }]),
	);
	writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "consumer", lockfileVersion: 3, packages: { "": {}, ...packages } }));
	return root;
}

function registry(metadata: Record<string, unknown>): string {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname.toLowerCase();
			if (path === "/%40scope%2fwidget/1.2.3") return Response.json(metadata);
			if (path === "/%40scope%2fwidget") return Response.json({ name: "@scope/widget", versions: { "1.2.3": metadata } });
			return new Response("missing", { status: 404 });
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function request(projectRoot: string, registryUrl: string, requestedVersion: string | null = null): PackageSourceRequest {
	return {
		projectRoot,
		coordinate: { ecosystem: "npm", registry: registryUrl, name: "@scope/widget", requestedVersion },
	};
}

function resolver(sourceRoot: string, cacheRoot = temp("lector-npm-source-cache-")): NpmPackageSourceResolver {
	return new NpmPackageSourceResolver({
		versions: new NpmLockfileVersionResolver(),
		registry: new NpmRegistryClient(),
		repositories: new GitRepoFetcher(cacheRoot, { resolveCloneUrl: () => sourceRoot }),
	});
}

describe("normalizeNpmRepository", () => {
	for (const [repository, expected] of [
		[{ type: "git", url: "git+https://github.com/acme/widgets.git", directory: "packages/widget" }, "https://github.com/acme/widgets.git"],
		[{ type: null, url: "git@github.com:acme/widgets.git", directory: null }, "https://github.com/acme/widgets.git"],
		[{ type: null, url: "github:acme/widgets", directory: null }, "https://github.com/acme/widgets.git"],
		[{ type: null, url: "acme/widgets", directory: null }, "https://github.com/acme/widgets.git"],
	] as const) {
		it(`normalizes ${repository.url}`, () => {
			expect(normalizeNpmRepository(repository)?.url).toBe(expected);
		});
	}

	it("rejects non-Git metadata, nested namespaces the fetch port cannot represent, and escaping directories", () => {
		expect(normalizeNpmRepository({ type: "svn", url: "https://github.com/acme/widgets", directory: null })).toBeNull();
		expect(normalizeNpmRepository({ type: "git", url: "https://gitlab.com/acme/team/widgets.git", directory: null })).toBeNull();
		expect(normalizeNpmRepository({ type: "git", url: "https://github.com/acme/widgets.git", directory: "../secret" })).toBeNull();
	});
});

describe("NpmPackageSourceResolver", () => {
	it("maps scoped registry metadata and a gitHead commit to an exact package subdirectory", async () => {
		const source = sourceRepository();
		const project = projectLock();
		const registryUrl = registry({
			name: "@scope/widget",
			version: "1.2.3",
			repository: { type: "git", url: "git+https://github.com/acme/widgets.git", directory: "packages/widget" },
			gitHead: source.commit,
			dist: { integrity: "sha512-registry-fixture" },
		});

		const outcome = await resolver(source.root).resolve(request(project, registryUrl), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.coordinate.resolvedVersion).toBe("1.2.3");
			expect(outcome.repository).toEqual({
				url: "https://github.com/acme/widgets.git",
				requestedRef: source.commit,
				resolvedRef: source.commit,
				commit: source.commit,
			});
			expect(outcome.workspace.readOnly).toBe(true);
			expect(JSON.parse(readFileSync(join(outcome.workspace.cachePath, "package.json"), "utf8")).name).toBe("@scope/widget");
		}
	});

	it("verifies an exact conventional tag when gitHead is absent instead of falling back to HEAD", async () => {
		const source = sourceRepository();
		const project = projectLock();
		const registryUrl = registry({
			name: "@scope/widget",
			version: "1.2.3",
			repository: { type: "git", url: "github:acme/widgets", directory: "packages/widget" },
		});

		const outcome = await resolver(source.root).resolve(request(project, registryUrl, "1.2.3"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.repository.requestedRef).toBe("v1.2.3");
			expect(outcome.repository.commit).toBe(source.commit);
		}
	});

	it("returns installed-version ambiguity before making a registry request", async () => {
		const source = sourceRepository();
		const project = projectLock(["1.2.3", "2.0.0"]);
		const outcome = await resolver(source.root).resolve(request(project, "http://127.0.0.1:1"), BOUNDS);

		expect(outcome.status).toBe("ambiguous");
		if (outcome.status === "ambiguous") expect(outcome.candidates.map((candidate) => candidate.version)).toEqual(["1.2.3", "2.0.0"]);
	});

	it("refuses missing repository metadata and registry coordinate mismatches", async () => {
		const source = sourceRepository();
		const project = projectLock();
		const missing = await resolver(source.root).resolve(request(project, registry({ name: "@scope/widget", version: "1.2.3" })), BOUNDS);
		expect(missing).toEqual({ status: "unavailable", code: "source-metadata-missing" });

		const mismatched = await resolver(source.root).resolve(
			request(project, registry({ name: "@scope/other", version: "1.2.3", repository: { type: "git", url: "github:acme/widgets" }, gitHead: source.commit })),
			BOUNDS,
		);
		expect(mismatched).toEqual({ status: "mismatched", code: "coordinate-mismatch", expected: "@scope/widget@1.2.3", actual: "@scope/other@1.2.3" });
	});

	it("refuses a missing exact commit and a source package identity mismatch", async () => {
		const source = sourceRepository({ version: "9.9.9" });
		const project = projectLock();
		const missingCommit = await resolver(source.root).resolve(
			request(
				project,
				registry({
					name: "@scope/widget",
					version: "1.2.3",
					repository: { type: "git", url: "github:acme/widgets", directory: "packages/widget" },
					gitHead: "2222222222222222222222222222222222222222",
				}),
			),
			BOUNDS,
		);
		expect(missingCommit).toEqual({ status: "unavailable", code: "unverifiable-source" });

		const wrongIdentity = await resolver(source.root).resolve(
			request(
				project,
				registry({
					name: "@scope/widget",
					version: "1.2.3",
					repository: { type: "git", url: "github:acme/widgets", directory: "packages/widget" },
					gitHead: source.commit,
				}),
			),
			BOUNDS,
		);
		expect(wrongIdentity).toEqual({ status: "mismatched", code: "coordinate-mismatch", expected: "@scope/widget@1.2.3", actual: "@scope/widget@9.9.9" });
	});

	it("refuses a package manifest symlink that escapes the fetched repository", async () => {
		const source = sourceRepository();
		rmSync(join(source.root, "packages/widget/package.json"));
		symlinkSync("/etc/passwd", join(source.root, "packages/widget/package.json"));
		git(source.root, "add", "packages/widget/package.json");
		git(source.root, "commit", "-q", "--amend", "--no-edit");
		const commit = git(source.root, "rev-parse", "HEAD");
		const project = projectLock();
		const registryUrl = registry({
			name: "@scope/widget",
			version: "1.2.3",
			repository: { type: "git", url: "github:acme/widgets", directory: "packages/widget" },
			gitHead: commit,
		});

		const outcome = await resolver(source.root).resolve(request(project, registryUrl), BOUNDS);

		expect(outcome).toEqual({ status: "unavailable", code: "unverifiable-source" });
	});

	it("maps the repository checkout byte limit to a bounded source outcome", async () => {
		const source = sourceRepository();
		const project = projectLock();
		const registryUrl = registry({
			name: "@scope/widget",
			version: "1.2.3",
			repository: { type: "git", url: "github:acme/widgets", directory: "packages/widget" },
			gitHead: source.commit,
		});

		const outcome = await resolver(source.root).resolve(request(project, registryUrl), { ...BOUNDS, maxCloneBytes: 1 });

		expect(outcome).toEqual(expect.objectContaining({ status: "oversized", code: "clone-limit-exceeded", resource: "clone-bytes", limit: 1 }));
	});
});
