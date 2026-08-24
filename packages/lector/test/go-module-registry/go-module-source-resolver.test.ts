import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { GoModuleSourceResolver } from "../../src/go-module-registry/go-module-source-resolver.ts";
import { GoProxyClient } from "../../src/go-module-registry/go-proxy-client.ts";
import type { InstalledGoModuleVersionOutcome, InstalledGoModuleVersionRequest } from "../../src/go-module-version-resolver/installed-go-module.ts";
import type { InstalledGoModuleVersionResolverPort } from "../../src/go-module-version-resolver/port.ts";
import type { PackageSourceBounds, PackageSourceRequest } from "../../src/package-source/package-source.ts";
import { GitRepoFetcher } from "../../src/repo-fetcher/git-repo-fetcher.ts";

const BOUNDS: PackageSourceBounds = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxManifestNesting: 64,
	maxWorkspaces: 100,
	maxDiagnostics: 20,
	maxRegistryResponseBytes: 1_000_000,
	maxRedirects: 3,
	maxRetries: 0,
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

function commitAll(root: string, tag: string): string {
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "release");
	git(root, "tag", tag);
	return git(root, "rev-parse", "HEAD");
}

function initRepo(): string {
	const root = temp("lector-go-source-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	return root;
}

function goProxyFixture(): string {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.endsWith(".info")) return Response.json({ Version: "v1.2.3", Time: "2024-01-01T00:00:00Z" });
			return new Response("not found", { status: 404 });
		},
	});
	servers.push(server);
	return server.url.toString();
}

function versions(outcome: InstalledGoModuleVersionOutcome): InstalledGoModuleVersionResolverPort {
	return { resolve: (_request: InstalledGoModuleVersionRequest) => Promise.resolve(outcome) };
}

function request(modulePath: string, requestedVersion: string | null = null): PackageSourceRequest {
	return { projectRoot: temp("lector-go-source-project-"), coordinate: { ecosystem: "go", registry: null, name: modulePath, requestedVersion } };
}

function resolverFor(installed: InstalledGoModuleVersionResolverPort, sourceRoot: string, proxyUrl: string): GoModuleSourceResolver {
	return new GoModuleSourceResolver({
		versions: installed,
		proxy: new GoProxyClient(),
		proxyUrl,
		repositories: new GitRepoFetcher(temp("lector-go-source-cache-"), { resolveCloneUrl: () => sourceRoot }),
	});
}

describe("GoModuleSourceResolver", () => {
	it("verifies a plain module-path require against its own repo-root go.mod", async () => {
		const source = initRepo();
		writeFileSync(join(source, "go.mod"), "module github.com/acme/widget\n\ngo 1.22\n");
		writeFileSync(join(source, "widget.go"), "package widget\n");
		const commit = commitAll(source, "v1.2.3");

		const installed = versions({
			status: "resolved",
			modulePath: "github.com/acme/widget",
			requestedVersion: null,
			version: "v1.2.3",
			evidence: [
				{ manifest: "go.mod", locator: "require github.com/acme/widget v1.2.3", kind: "module-path", directSource: null, commit: null, checksum: null },
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source, goProxyFixture()).resolve(request("github.com/acme/widget"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.coordinate.resolvedVersion).toBe("v1.2.3");
			expect(outcome.repository).toEqual({ url: "https://github.com/acme/widget.git", requestedRef: "v1.2.3", resolvedRef: "v1.2.3", commit });
			expect(outcome.verification.method).toBe("registry-metadata-and-commit");
		}
	});

	it("verifies a module living in a repo subdirectory as its own nested go.mod", async () => {
		const source = initRepo();
		writeFileSync(join(source, "go.mod"), "module github.com/acme/monorepo\n\ngo 1.22\n");
		mkdirSync(join(source, "sub"), { recursive: true });
		writeFileSync(join(source, "sub/go.mod"), "module github.com/acme/monorepo/sub\n\ngo 1.22\n");
		commitAll(source, "sub/v1.2.3");

		const installed = versions({
			status: "resolved",
			modulePath: "github.com/acme/monorepo/sub",
			requestedVersion: null,
			version: "v1.2.3",
			evidence: [
				{ manifest: "go.mod", locator: "require github.com/acme/monorepo/sub v1.2.3", kind: "module-path", directSource: null, commit: null, checksum: null },
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source, goProxyFixture()).resolve(request("github.com/acme/monorepo/sub"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.repository.requestedRef).toBe("sub/v1.2.3");
			expect(outcome.workspace.cachePath.endsWith("/sub")).toBe(true);
		}
	});

	it("verifies a plain subpackage (no nested go.mod) against the repo root's own go.mod, tagged without a subdirectory prefix", async () => {
		const source = initRepo();
		writeFileSync(join(source, "go.mod"), "module github.com/acme/monorepo\n\ngo 1.22\n");
		mkdirSync(join(source, "sub"), { recursive: true });
		writeFileSync(join(source, "sub/pkg.go"), "package sub\n");
		commitAll(source, "v1.2.3");

		const installed = versions({
			status: "resolved",
			modulePath: "github.com/acme/monorepo/sub",
			requestedVersion: null,
			version: "v1.2.3",
			evidence: [
				{ manifest: "go.mod", locator: "require github.com/acme/monorepo/sub v1.2.3", kind: "module-path", directSource: null, commit: null, checksum: null },
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source, goProxyFixture()).resolve(request("github.com/acme/monorepo/sub"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") expect(outcome.repository.requestedRef).toBe("v1.2.3");
	});

	it("verifies a direct-VCS replace's own already-pinned commit directly, skipping GOPROXY entirely", async () => {
		const source = initRepo();
		writeFileSync(join(source, "go.mod"), "module github.com/example/vcs-dep\n\ngo 1.22\n");
		const commit = commitAll(source, "unused");

		const installed = versions({
			status: "resolved",
			modulePath: "example.com/vcs-dep",
			requestedVersion: null,
			version: commit,
			evidence: [
				{
					manifest: "go.mod",
					locator: `replace example.com/vcs-dep => github.com/example/vcs-dep ${commit}`,
					kind: "vcs-replace",
					directSource: "github.com/example/vcs-dep",
					commit,
					checksum: null,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source, "http://127.0.0.1:1").resolve(request("example.com/vcs-dep"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.verification.method).toBe("lockfile-vcs-pin");
			expect(outcome.repository.commit).toBe(commit);
		}
	});

	it("registers a real local-path replace directly from disk, with no fetch at all", async () => {
		const localRoot = temp("lector-go-local-replace-");
		writeFileSync(join(localRoot, "go.mod"), "module example.com/local-fixturedep\n\ngo 1.22\n");
		const installed = versions({
			status: "resolved",
			modulePath: "example.com/fixturedep",
			requestedVersion: null,
			version: "v1.2.3",
			evidence: [
				{
					manifest: "go.mod",
					locator: "replace example.com/fixturedep => ../local-fixturedep",
					kind: "local-replace",
					directSource: localRoot,
					commit: null,
					checksum: null,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, temp("lector-go-unused-source-"), "http://127.0.0.1:1").resolve(request("example.com/fixturedep"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.workspace.origin).toBe("local");
			expect(outcome.workspace.cachePath).toBe(localRoot);
			expect(outcome.verification.method).toBe("local-content-digest");
		}
	});

	it("reports a coordinate mismatch when the cloned repo's own go.mod names a different module", async () => {
		const source = initRepo();
		writeFileSync(join(source, "go.mod"), "module github.com/acme/different-module\n\ngo 1.22\n");
		commitAll(source, "v1.2.3");

		const installed = versions({
			status: "resolved",
			modulePath: "github.com/acme/widget",
			requestedVersion: null,
			version: "v1.2.3",
			evidence: [
				{ manifest: "go.mod", locator: "require github.com/acme/widget v1.2.3", kind: "module-path", directSource: null, commit: null, checksum: null },
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source, goProxyFixture()).resolve(request("github.com/acme/widget"), BOUNDS);

		expect(outcome).toEqual({
			status: "mismatched",
			code: "coordinate-mismatch",
			expected: "github.com/acme/widget",
			actual: "github.com/acme/different-module",
		});
	});

	it("refuses a module path on a host with no known VCS convention -- a vanity import, out of scope", async () => {
		const installed = versions({
			status: "resolved",
			modulePath: "golang.org/x/mod",
			requestedVersion: null,
			version: "v0.15.0",
			evidence: [{ manifest: "go.mod", locator: "require golang.org/x/mod v0.15.0", kind: "module-path", directSource: null, commit: null, checksum: null }],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, temp("lector-go-unused-source-2"), "http://127.0.0.1:1").resolve(request("golang.org/x/mod"), BOUNDS);

		expect(outcome).toEqual({ status: "unavailable", code: "unverifiable-source" });
	});

	it("returns installed-version ambiguity before making any GOPROXY request", async () => {
		const installed = versions({
			status: "ambiguous",
			modulePath: "github.com/acme/widget",
			requestedVersion: null,
			candidates: [
				{ version: "v1.0.0", evidence: [], evidenceTruncated: false },
				{ version: "v2.0.0", evidence: [], evidenceTruncated: false },
			],
			truncated: false,
		});

		const outcome = await resolverFor(installed, temp("lector-go-unused-source-3"), "http://127.0.0.1:1").resolve(request("github.com/acme/widget"), BOUNDS);

		expect(outcome.status).toBe("ambiguous");
		if (outcome.status === "ambiguous") expect(outcome.candidates.map((candidate) => candidate.version)).toEqual(["v1.0.0", "v2.0.0"]);
	});
});
