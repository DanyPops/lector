import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Server } from "bun";
import { RipgrepTextSearch } from "../../src/adapters/ripgrep-text-search.ts";
import { deriveSourceManifest } from "../../src/adapters/source-manifest.ts";
import type { NpmPackageCandidate } from "../../src/domain/external-search-result.ts";
import { TYPESCRIPT_DESCRIPTOR } from "../../src/domain/language-server-descriptor.ts";
import type { NpmPackageVersionMetadata } from "../../src/domain/npm-package-metadata.ts";
import { LocalGit } from "../../src/git/local-git.ts";
import { NpmLockfileVersionResolver } from "../../src/installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import { NpmPackageSourceResolver } from "../../src/npm-registry/npm-package-source-resolver.ts";
import { NpmRegistryClient } from "../../src/npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "../../src/npm-registry/port.ts";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS } from "../../src/package-source/package-source.ts";
import { GitRepoFetcher } from "../../src/repo-fetcher/git-repo-fetcher.ts";
import { createLectorService, type LectorService } from "../../src/service.ts";
import {
	materializeTypeScriptReferenceFixture,
	materializeTypeScriptReferenceGitFixture,
	readTypeScriptReferenceManifest,
	type TypeScriptReferenceFixture,
} from "../support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;
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

class FixedRegistry implements NpmRegistryPort {
	constructor(private readonly metadata: NpmPackageVersionMetadata) {}
	fetchVersion(): Promise<NpmPackageVersionMetadata> {
		return Promise.resolve(this.metadata);
	}
	search(): Promise<readonly NpmPackageCandidate[]> {
		return Promise.resolve([]);
	}
}

describe("TypeScript/JavaScript reference fixture capability conformance", () => {
	it("keeps lexical text discovery separate from semantic and structural symbol identity", async () => {
		fixture = materializeTypeScriptReferenceGitFixture();
		const marker = readTypeScriptReferenceManifest(fixture.root).lexicalMarker;
		const result = await new RipgrepTextSearch().search(fixture.root, marker, { maxMatches: 10, maxBytes: 10_000 });

		expect(result.matches.some(({ path }) => path === "packages/app/src/raw-text.ts")).toBe(true);
		expect(result.matches.some(({ path }) => path === "fixture.json")).toBe(true);
		expect(result.truncated).toBe(false);
	});

	it("records a graph generation and invalidates it after an exact hash-guarded source edit", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		const manifest = await deriveSourceManifest(fixture.root, TYPESCRIPT_DESCRIPTOR.extensions, 1, 2_000_000);
		const relativePath = relative(fixture.root, manifest.absoluteFiles[0] ?? "");
		if (!relativePath) throw new Error("reference fixture has no source file");

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 1, maxSymbolsPerFile: 10 });
		const cached = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 1, maxSymbolsPerFile: 10 });
		expect(cached.status).toBe("cached");
		if (cached.status === "cached") expect(cached.generation.provenance).toMatchObject({ fidelity: "semantic", backend: "typescript-language-server" });

		const before = await service.dispatch("workspace.rawRead", { workspaceId, path: relativePath });
		await service.dispatch("workspace.exactEdit", {
			workspaceId,
			path: relativePath,
			expectedHash: before.hash,
			content: `${before.content}\nexport const generationMutation = true;\n`,
		});
		const stale = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 1, maxSymbolsPerFile: 10 });
		expect(stale).toEqual({ status: "not-cached", reason: "source-changed" });
	}, 30_000);

	it("compares the same fixture across bounded Git versions and preserves its rename", async () => {
		const gitFixture = materializeTypeScriptReferenceGitFixture();
		fixture = gitFixture;
		const result = await new LocalGit(gitFixture.root).diff(gitFixture.baselineRef, 20_000);

		expect(result.truncated).toBe(false);
		expect(result.diff).toContain("payment.ts");
		expect(result.diff).toContain("purchase.ts");
		expect(result.diff).toContain("PurchaseOrder");
	});

	it("reports package-source ambiguity consistently across npm-compatible lock formats", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const resolver = new NpmLockfileVersionResolver();
		for (const manager of ["npm", "pnpm", "yarn", "bun"] as const) {
			const outcome = await resolver.resolve(
				{
					projectRoot: join(fixture.root, "locks", manager),
					packageName: "@fixture/dependency",
					requestedVersion: null,
				},
				{ ...DEFAULT_PACKAGE_SOURCE_BOUNDS, maxEvidencePerVersion: 10 },
			);
			expect(outcome.status).toBe("ambiguous");
		}
	});

	it("bounds registry retries while reading the fixture's exact metadata", async () => {
		fixture = materializeTypeScriptReferenceFixture();
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

		const result = await new NpmRegistryClient().fetchVersion(
			{ registry: `http://127.0.0.1:${server.port}`, name: "@fixture/dependency", version: "1.2.3" },
			{ maxResponseBytes: 100_000, maxRedirects: 1, maxRetries: 1, timeoutMs: 5_000 },
		);

		expect(attempts).toBe(2);
		expect(result).toMatchObject({ name: "@fixture/dependency", version: "1.2.3", gitHead: "1111111111111111111111111111111111111111" });
	});

	it("fetches and verifies an exact package commit from the fixture outside the consumer worktree", async () => {
		const gitFixture = materializeTypeScriptReferenceGitFixture();
		fixture = gitFixture;
		const packagePath = join(fixture.root, "packages/contracts/package.json");
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
		writeFileSync(packagePath, JSON.stringify({ ...packageJson, name: "@fixture/dependency", version: "1.2.3" }));
		git(fixture.root, "add", "packages/contracts/package.json");
		git(fixture.root, "commit", "-q", "-m", "publish fixture dependency");
		const commit = git(fixture.root, "rev-parse", "HEAD");
		const cacheRoot = temp("lector-reference-source-cache-");
		const source = new NpmPackageSourceResolver({
			versions: new NpmLockfileVersionResolver(),
			registry: new FixedRegistry({
				name: "@fixture/dependency",
				version: "1.2.3",
				repository: { type: "git", url: "git+https://github.com/fixture/dependency.git", directory: "packages/contracts" },
				gitHead: commit,
				integrity: "sha512-fixture123",
			}),
			repositories: new GitRepoFetcher(cacheRoot, { resolveCloneUrl: () => fixture?.root ?? "" }),
		});

		const outcome = await source.resolve(
			{
				projectRoot: join(fixture.root, "locks/npm"),
				coordinate: {
					ecosystem: "npm",
					registry: "https://registry.example",
					name: "@fixture/dependency",
					requestedVersion: "1.2.3",
				},
			},
			DEFAULT_PACKAGE_SOURCE_BOUNDS,
		);

		expect(outcome.status).toBe("verified");
		if (outcome.status !== "verified") return;
		expect(outcome.repository.commit).toBe(commit);
		expect(outcome.workspace.readOnly).toBe(true);
		expect(outcome.workspace.cachePath.startsWith(cacheRoot)).toBe(true);
		expect(outcome.workspace.cachePath.startsWith(join(fixture.root, "locks/npm"))).toBe(false);
	}, 30_000);
});
