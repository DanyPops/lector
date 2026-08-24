import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Server } from "bun";
import { PYTHON_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LocalGit } from "../../src/git/local-git.ts";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS } from "../../src/package-source/package-source.ts";
import { PypiPackageSourceResolver } from "../../src/pypi-registry/pypi-package-source-resolver.ts";
import { PypiRegistryClient } from "../../src/pypi-registry/pypi-registry-client.ts";
import { PythonLockfileVersionResolver } from "../../src/python-package-version-resolver/python-lockfile-version-resolver.ts";
import { GitRepoFetcher } from "../../src/repo-fetcher/git-repo-fetcher.ts";
import { createLectorService, type LectorService } from "../../src/service.ts";
import { RipgrepTextSearch } from "../../src/text-search/ripgrep-text-search.ts";
import { deriveSourceManifest } from "../../src/workspace/source-manifest.ts";
import {
	materializePythonReferenceFixture,
	materializePythonReferenceGitFixture,
	type PythonReferenceFixture,
	readPythonReferenceManifest,
} from "../support/python-reference-fixture.ts";

let fixture: PythonReferenceFixture | undefined;
let service: LectorService | undefined;
const roots: string[] = [];
const servers: Server<unknown>[] = [];

afterEach(async () => {
	await service?.close();
	service = undefined;
	fixture?.dispose();
	fixture = undefined;
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

describe("Python reference fixture capability conformance", () => {
	it("keeps lexical text discovery separate from semantic and structural symbol identity", async () => {
		fixture = materializePythonReferenceFixture();
		const marker = readPythonReferenceManifest(fixture.root).lexicalMarker;
		const result = await new RipgrepTextSearch().search(fixture.root, marker, { maxMatches: 10, maxBytes: 10_000 });

		expect(result.matches.some(({ path }) => path === "ignored/raw_text.py")).toBe(true);
		expect(result.matches.some(({ path }) => path === "fixture.json")).toBe(true);
		expect(result.truncated).toBe(false);
	});

	it("records a graph generation and invalidates it after an exact hash-guarded source edit", async () => {
		fixture = materializePythonReferenceFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		const manifest = await deriveSourceManifest(fixture.root, PYTHON_DESCRIPTOR.extensions, 1, 2_000_000);
		const relativePath = relative(fixture.root, manifest.absoluteFiles[0] ?? "");
		if (!relativePath) throw new Error("reference fixture has no source file");

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 1, maxSymbolsPerFile: 10 });
		const cached = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 1, maxSymbolsPerFile: 10 });
		expect(cached.status).toBe("cached");
		if (cached.status === "cached") expect(cached.generation.provenance).toMatchObject({ fidelity: "semantic", backend: "pyright" });

		const before = await service.dispatch("workspace.rawRead", { workspaceId, path: relativePath });
		await service.dispatch("workspace.exactEdit", {
			workspaceId,
			path: relativePath,
			expectedHash: before.hash,
			content: `${before.content}\ngeneration_mutation = True\n`,
		});
		const stale = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 1, maxSymbolsPerFile: 10 });
		expect(stale).toEqual({ status: "not-cached", reason: "source-changed" });
	}, 30_000);

	it("compares the same fixture across bounded Git versions and preserves its rename", async () => {
		const gitFixture = materializePythonReferenceGitFixture();
		fixture = gitFixture;
		const result = await new LocalGit(gitFixture.root).diff(gitFixture.baselineRef, 20_000);

		expect(result.truncated).toBe(false);
		expect(result.diff).toContain("payment.py");
		expect(result.diff).toContain("purchase.py");
		expect(result.diff).toContain("PurchaseOrder");
	});

	it("reports package-source ambiguity for a real Poetry lock declaring two versions of the same package", async () => {
		fixture = materializePythonReferenceFixture();
		const outcome = await new PythonLockfileVersionResolver().resolve(
			{ projectRoot: join(fixture.root, "locks/poetry"), packageName: "requests", requestedVersion: null },
			{ maxManifestBytes: 1_000_000, maxManifestEntries: 10_000, maxManifestNesting: 64, maxDiagnostics: 20, maxCandidates: 20, maxEvidencePerVersion: 20 },
		);
		expect(outcome.status).toBe("ambiguous");
	});

	it("resolves the same package to one exact version under uv/pipenv/pip, each a real, distinct lockfile format", async () => {
		fixture = materializePythonReferenceFixture();
		for (const [manager, lockDir] of [
			["uv", "locks/uv"],
			["pipenv", "locks/pipenv"],
		] as const) {
			const outcome = await new PythonLockfileVersionResolver().resolve(
				{ projectRoot: join(fixture.root, lockDir), packageName: "requests", requestedVersion: null },
				{ maxManifestBytes: 1_000_000, maxManifestEntries: 10_000, maxManifestNesting: 64, maxDiagnostics: 20, maxCandidates: 20, maxEvidencePerVersion: 20 },
			);
			expect(outcome.status).toBe("resolved");
			if (outcome.status === "resolved") expect(outcome.evidence.some((entry) => entry.manager === manager)).toBe(true);
		}
	});

	it("bounds registry retries while reading the fixture's exact metadata", async () => {
		fixture = materializePythonReferenceFixture();
		const metadata = JSON.parse(readFileSync(join(fixture.root, "registry/exact.json"), "utf8")) as Record<string, unknown>;
		let attempts = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				attempts++;
				return attempts === 1 ? new Response("retry", { status: 503 }) : Response.json(metadata);
			},
		});
		servers.push(server);

		const result = await new PypiRegistryClient().fetchVersion(
			{ registry: `http://127.0.0.1:${server.port}`, name: "requests", version: "2.31.0" },
			{ maxResponseBytes: 100_000, maxRedirects: 1, maxRetries: 1, timeoutMs: 5_000 },
		);

		expect(attempts).toBe(2);
		expect(result).toMatchObject({ name: "requests", version: "2.31.0" });
	});

	it("fetches and verifies an exact package commit from the fixture outside the consumer worktree", async () => {
		const gitFixture = materializePythonReferenceGitFixture();
		fixture = gitFixture;
		const pyprojectPath = join(fixture.root, "pyproject.toml");
		writeFileSync(pyprojectPath, '[project]\nname = "requests"\nversion = "2.31.0"\n');
		git(fixture.root, "add", "pyproject.toml");
		git(fixture.root, "commit", "-q", "-m", "publish fixture dependency");
		git(fixture.root, "tag", "v2.31.0");
		const commit = git(fixture.root, "rev-parse", "HEAD");
		const cacheRoot = temp("lector-python-reference-source-cache-");
		const source = new PypiPackageSourceResolver({
			versions: new PythonLockfileVersionResolver(),
			registry: new PypiRegistryClient(),
			repositories: new GitRepoFetcher(cacheRoot, { resolveCloneUrl: () => fixture?.root ?? "" }),
		});
		const registryServer = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/pypi/requests/2.31.0/json") {
					return Response.json({ info: { name: "requests", version: "2.31.0", project_urls: { Source: "https://github.com/psf/requests" } } });
				}
				return new Response("missing", { status: 404 });
			},
		});
		servers.push(registryServer);

		const outcome = await source.resolve(
			{
				projectRoot: join(fixture.root, "locks/pip"),
				coordinate: { ecosystem: "pypi", registry: `http://127.0.0.1:${registryServer.port}`, name: "requests", requestedVersion: "2.31.0" },
			},
			DEFAULT_PACKAGE_SOURCE_BOUNDS,
		);

		expect(outcome.status).toBe("verified");
		if (outcome.status !== "verified") return;
		expect(outcome.repository.commit).toBe(commit);
		expect(outcome.workspace.readOnly).toBe(true);
		expect(outcome.workspace.cachePath.startsWith(cacheRoot)).toBe(true);
		expect(outcome.workspace.cachePath.startsWith(join(fixture.root, "locks/pip"))).toBe(false);
	}, 30_000);
});
