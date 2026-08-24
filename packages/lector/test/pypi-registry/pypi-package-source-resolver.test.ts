import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { PackageSourceBounds, PackageSourceRequest } from "../../src/package-source/package-source.ts";
import { PypiPackageSourceResolver } from "../../src/pypi-registry/pypi-package-source-resolver.ts";
import { PypiRegistryClient } from "../../src/pypi-registry/pypi-registry-client.ts";
import type { InstalledPythonVersionOutcome, InstalledPythonVersionRequest } from "../../src/python-package-version-resolver/installed-package-version.ts";
import type { InstalledPythonVersionResolverPort } from "../../src/python-package-version-resolver/port.ts";
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
	const root = temp("lector-pypi-source-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "pyproject.toml"), `[project]\nname = "${identity.name ?? "widget"}"\nversion = "${identity.version ?? "1.2.3"}"\n`);
	writeFileSync(join(root, "widget.py"), "value = 1\n");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "release");
	git(root, "tag", "v1.2.3");
	return { root, commit: git(root, "rev-parse", "HEAD") };
}

/** A minimal fake -- every test here drives PypiPackageSourceResolver's own real logic through the exact same InstalledPythonVersionResolverPort contract PythonLockfileVersionResolver implements, without needing a real project-root lockfile for every scenario. */
function versions(outcome: InstalledPythonVersionOutcome): InstalledPythonVersionResolverPort {
	return { resolve: (_request: InstalledPythonVersionRequest) => Promise.resolve(outcome) };
}

function registry(metadata: Record<string, unknown>): string {
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/pypi/widget/1.2.3/json") return Response.json(metadata);
			if (path === "/pypi/widget/json") return Response.json({ info: { name: "widget" }, releases: { "1.2.3": [] } });
			return new Response("missing", { status: 404 });
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function request(registryUrl: string, requestedVersion: string | null = null): PackageSourceRequest {
	return { projectRoot: temp("lector-pypi-source-project-"), coordinate: { ecosystem: "pypi", registry: registryUrl, name: "widget", requestedVersion } };
}

function resolver(installed: InstalledPythonVersionResolverPort, sourceRoot: string, cacheRoot = temp("lector-pypi-source-cache-")): PypiPackageSourceResolver {
	return new PypiPackageSourceResolver({
		versions: installed,
		registry: new PypiRegistryClient(),
		repositories: new GitRepoFetcher(cacheRoot, { resolveCloneUrl: () => sourceRoot }),
	});
}

describe("PypiPackageSourceResolver", () => {
	it("maps real PyPI project_urls metadata to a verified conventional tag", async () => {
		const source = sourceRepository();
		const installed = versions({ status: "resolved", packageName: "widget", requestedVersion: null, version: "1.2.3", evidence: [], evidenceTruncated: false });
		const registryUrl = registry({ info: { name: "widget", version: "1.2.3", project_urls: { Source: "https://github.com/acme/widget" } } });

		const outcome = await resolver(installed, source.root).resolve(request(registryUrl), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.coordinate.resolvedVersion).toBe("1.2.3");
			expect(outcome.repository).toEqual({ url: "https://github.com/acme/widget.git", requestedRef: "v1.2.3", resolvedRef: "v1.2.3", commit: source.commit });
			expect(outcome.verification.method).toBe("registry-metadata-and-commit");
			expect(readFileSync(join(outcome.workspace.cachePath, "pyproject.toml"), "utf8")).toContain('name = "widget"');
		}
	});

	it("returns installed-version ambiguity before making any registry request", async () => {
		const source = sourceRepository();
		const installed = versions({
			status: "ambiguous",
			packageName: "widget",
			requestedVersion: null,
			candidates: [
				{ version: "1.2.3", evidence: [], evidenceTruncated: false },
				{ version: "2.0.0", evidence: [], evidenceTruncated: false },
			],
			truncated: false,
		});

		const outcome = await resolver(installed, source.root).resolve(request("http://127.0.0.1:1"), BOUNDS);

		expect(outcome.status).toBe("ambiguous");
		if (outcome.status === "ambiguous") expect(outcome.candidates.map((candidate) => candidate.version)).toEqual(["1.2.3", "2.0.0"]);
	});

	it("refuses missing repository metadata and a source identity mismatch", async () => {
		const source = sourceRepository({ name: "different-package" });
		const installed = versions({ status: "resolved", packageName: "widget", requestedVersion: null, version: "1.2.3", evidence: [], evidenceTruncated: false });

		const missing = await resolver(installed, source.root).resolve(
			request(registry({ info: { name: "widget", version: "1.2.3", project_urls: null } })),
			BOUNDS,
		);
		expect(missing).toEqual({ status: "unavailable", code: "source-metadata-missing" });

		const mismatched = await resolver(installed, source.root).resolve(
			request(registry({ info: { name: "widget", version: "1.2.3", project_urls: { Source: "https://github.com/acme/widget" } } })),
			BOUNDS,
		);
		expect(mismatched).toEqual({ status: "mismatched", code: "coordinate-mismatch", expected: "widget@1.2.3", actual: "different-package@1.2.3" });
	});

	it("verifies a direct-VCS install's own already-pinned commit directly, skipping the PyPI registry entirely", async () => {
		const source = sourceRepository();
		const installed = versions({
			status: "resolved",
			packageName: "widget",
			requestedVersion: null,
			version: source.commit,
			evidence: [
				{
					manager: "pip",
					lockfile: "requirements.txt",
					locator: "widget @ git+...",
					kind: "direct-vcs",
					directSource: "https://github.com/acme/widget.git",
					commit: source.commit,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolver(installed, source.root).resolve(request("http://127.0.0.1:1"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.verification.method).toBe("lockfile-vcs-pin");
			expect(outcome.repository.commit).toBe(source.commit);
		}
	});

	it("registers a real local editable install directly from disk, with no fetch at all", async () => {
		const localRoot = temp("lector-pypi-local-editable-");
		writeFileSync(join(localRoot, "pyproject.toml"), '[project]\nname = "widget"\nversion = "0.1.0"\n');
		const installed = versions({
			status: "resolved",
			packageName: "widget",
			requestedVersion: null,
			version: "0.1.0",
			evidence: [{ manager: "pip", lockfile: "requirements.txt", locator: "-e ./widget", kind: "editable", directSource: `file://${localRoot}`, commit: null }],
			evidenceTruncated: false,
		});

		const outcome = await resolver(installed, temp("lector-pypi-unused-source-")).resolve(request("http://127.0.0.1:1"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.workspace.origin).toBe("local");
			expect(outcome.workspace.cachePath).toBe(localRoot);
			expect(outcome.verification.method).toBe("local-content-digest");
		}
	});

	it("refuses a plain direct-URL install -- there is no VCS metadata at all to verify a source from", async () => {
		const installed = versions({
			status: "resolved",
			packageName: "widget",
			requestedVersion: null,
			version: "1.0.0",
			evidence: [
				{
					manager: "pip",
					lockfile: "requirements.txt",
					locator: "widget @ https://.../widget.whl",
					kind: "direct-url",
					directSource: "https://.../widget.whl",
					commit: null,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolver(installed, temp("lector-pypi-unused-source-2")).resolve(request("http://127.0.0.1:1"), BOUNDS);

		expect(outcome).toEqual({ status: "unavailable", code: "source-metadata-missing" });
	});

	it("maps the repository checkout byte limit to a bounded source outcome", async () => {
		const source = sourceRepository();
		const installed = versions({ status: "resolved", packageName: "widget", requestedVersion: null, version: "1.2.3", evidence: [], evidenceTruncated: false });
		const registryUrl = registry({ info: { name: "widget", version: "1.2.3", project_urls: { Source: "https://github.com/acme/widget" } } });

		const outcome = await resolver(installed, source.root).resolve(request(registryUrl), { ...BOUNDS, maxCloneBytes: 1 });

		expect(outcome).toEqual(expect.objectContaining({ status: "oversized", code: "clone-limit-exceeded", resource: "clone-bytes", limit: 1 }));
	});
});
