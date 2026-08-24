import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { CratesIoPackageSourceResolver } from "../../src/crates-io-registry/crates-io-package-source-resolver.ts";
import { CratesIoRegistryClient } from "../../src/crates-io-registry/crates-io-registry-client.ts";
import type { PackageSourceBounds, PackageSourceRequest } from "../../src/package-source/package-source.ts";
import { GitRepoFetcher } from "../../src/repo-fetcher/git-repo-fetcher.ts";
import type { InstalledCrateVersionOutcome, InstalledCrateVersionRequest } from "../../src/rust-crate-version-resolver/installed-crate.ts";
import type { InstalledCrateVersionResolverPort } from "../../src/rust-crate-version-resolver/port.ts";

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

function sourceRepository(identity: { name?: string; version?: string } = {}): { root: string; commit: string } {
	const root = temp("lector-crate-source-repo-");
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "Cargo.toml"), `[package]\nname = "${identity.name ?? "widget"}"\nversion = "${identity.version ?? "1.2.3"}"\nedition = "2021"\n`);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "lib.rs"), "");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "release");
	git(root, "tag", "v1.2.3");
	return { root, commit: git(root, "rev-parse", "HEAD") };
}

function versions(outcome: InstalledCrateVersionOutcome): InstalledCrateVersionResolverPort {
	return { resolve: (_request: InstalledCrateVersionRequest) => Promise.resolve(outcome) };
}

function registryFixture(handler: (path: string) => Response): string {
	const server = Bun.serve({ port: 0, fetch: (request) => handler(new URL(request.url).pathname) });
	servers.push(server);
	return server.url.toString();
}

function request(crateName: string, requestedVersion: string | null = null): PackageSourceRequest {
	return { projectRoot: temp("lector-crate-source-project-"), coordinate: { ecosystem: "cargo", registry: null, name: crateName, requestedVersion } };
}

function resolverFor(installed: InstalledCrateVersionResolverPort, sourceRoot: string): CratesIoPackageSourceResolver {
	return new CratesIoPackageSourceResolver({
		versions: installed,
		registry: new CratesIoRegistryClient(),
		repositories: new GitRepoFetcher(temp("lector-crate-source-cache-"), { resolveCloneUrl: () => sourceRoot }),
	});
}

describe("CratesIoPackageSourceResolver", () => {
	it("maps real crates.io repository metadata to a verified conventional tag", async () => {
		const source = sourceRepository();
		const registryUrl = registryFixture(() =>
			Response.json({ crate: { name: "widget", repository: "https://github.com/acme/widget" }, versions: [{ num: "1.2.3", yanked: false }] }),
		);
		const installed = versions({
			status: "resolved",
			crateName: "widget",
			requestedVersion: null,
			version: "1.2.3",
			evidence: [
				{
					manifest: "Cargo.lock",
					locator: "[[package]] widget 1.2.3",
					kind: "registry",
					realName: null,
					registryUrl,
					directSource: null,
					commit: null,
					gitRef: null,
					checksum: "aaaa",
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source.root).resolve(request("widget"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.repository).toEqual({ url: "https://github.com/acme/widget.git", requestedRef: "v1.2.3", resolvedRef: "v1.2.3", commit: source.commit });
			expect(outcome.verification.method).toBe("registry-metadata-and-commit");
		}
	});

	it("returns installed-version ambiguity before making any registry request", async () => {
		const source = sourceRepository();
		const installed = versions({
			status: "ambiguous",
			crateName: "widget",
			requestedVersion: null,
			candidates: [
				{ version: "1.0.0", evidence: [], evidenceTruncated: false },
				{ version: "2.0.0", evidence: [], evidenceTruncated: false },
			],
			truncated: false,
		});
		const outcome = await resolverFor(installed, source.root).resolve(request("widget"), BOUNDS);
		expect(outcome.status).toBe("ambiguous");
		if (outcome.status === "ambiguous") expect(outcome.candidates.map((c) => c.version)).toEqual(["1.0.0", "2.0.0"]);
	});

	it("refuses missing repository metadata and reports a real coordinate mismatch", async () => {
		const source = sourceRepository({ name: "different-crate" });
		function installedFor(registryUrl: string): InstalledCrateVersionResolverPort {
			return versions({
				status: "resolved",
				crateName: "widget",
				requestedVersion: null,
				version: "1.2.3",
				evidence: [
					{
						manifest: "Cargo.lock",
						locator: "x",
						kind: "registry",
						realName: null,
						registryUrl,
						directSource: null,
						commit: null,
						gitRef: null,
						checksum: null,
					},
				],
				evidenceTruncated: false,
			});
		}

		const missingRegistryUrl = registryFixture(() =>
			Response.json({ crate: { name: "widget", repository: null }, versions: [{ num: "1.2.3", yanked: false }] }),
		);
		const missing = await resolverFor(installedFor(missingRegistryUrl), source.root).resolve(request("widget"), BOUNDS);
		expect(missing).toEqual({ status: "unavailable", code: "source-metadata-missing" });

		const mismatchRegistryUrl = registryFixture(() =>
			Response.json({ crate: { name: "widget", repository: "https://github.com/acme/widget" }, versions: [{ num: "1.2.3", yanked: false }] }),
		);
		const mismatched = await resolverFor(installedFor(mismatchRegistryUrl), source.root).resolve(request("widget"), BOUNDS);
		expect(mismatched).toEqual({ status: "mismatched", code: "coordinate-mismatch", expected: "widget@1.2.3", actual: "different-crate@1.2.3" });
	});

	it("verifies a git dependency's own already-pinned commit directly, skipping the registry entirely", async () => {
		const source = sourceRepository({ name: "fixturedep" });
		const installed = versions({
			status: "resolved",
			crateName: "fixturedep",
			requestedVersion: null,
			version: source.commit,
			evidence: [
				{
					manifest: "Cargo.toml",
					locator: 'fixturedep = { git = "..." }',
					kind: "git",
					realName: null,
					registryUrl: null,
					directSource: "https://github.com/example/fixturedep.git",
					commit: source.commit,
					gitRef: null,
					checksum: null,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source.root).resolve(request("fixturedep"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.verification.method).toBe("lockfile-vcs-pin");
			expect(outcome.repository.commit).toBe(source.commit);
		}
	});

	it("registers a real workspace-local crate directly from disk, with no fetch at all", async () => {
		const localRoot = temp("lector-crate-local-");
		writeFileSync(join(localRoot, "Cargo.toml"), '[package]\nname = "contracts"\nversion = "0.1.0"\nedition = "2021"\n');
		const installed = versions({
			status: "resolved",
			crateName: "contracts",
			requestedVersion: null,
			version: "0.1.0",
			evidence: [
				{
					manifest: "Cargo.lock",
					locator: "x",
					kind: "path",
					realName: null,
					registryUrl: null,
					directSource: localRoot,
					commit: null,
					gitRef: null,
					checksum: null,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, temp("lector-crate-unused-source-")).resolve(request("contracts"), BOUNDS);

		expect(outcome.status).toBe("verified");
		if (outcome.status === "verified") {
			expect(outcome.workspace.origin).toBe("local");
			expect(outcome.workspace.cachePath).toBe(localRoot);
			expect(outcome.verification.method).toBe("local-content-digest");
		}
	});

	it("reports a real repository-ref-mismatch for a tag that does not exist on the real repo", async () => {
		const source = sourceRepository({ name: "fixturedep" });
		const installed = versions({
			status: "resolved",
			crateName: "fixturedep",
			requestedVersion: null,
			version: "v9.9.9",
			evidence: [
				{
					manifest: "Cargo.toml",
					locator: 'fixturedep = { git = "...", tag = "v9.9.9" }',
					kind: "git",
					realName: null,
					registryUrl: null,
					directSource: "https://github.com/example/fixturedep.git",
					commit: null,
					gitRef: "v9.9.9",
					checksum: null,
				},
			],
			evidenceTruncated: false,
		});

		const outcome = await resolverFor(installed, source.root).resolve(request("fixturedep"), BOUNDS);

		expect(outcome.status).toBe("mismatched");
		if (outcome.status === "mismatched") expect(outcome.code).toBe("repository-ref-mismatch");
	});
});
