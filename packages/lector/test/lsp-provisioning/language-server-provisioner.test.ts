import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallLocation } from "../../src/lsp-provisioning/install-location.ts";
import { LanguageServerProvisioner } from "../../src/lsp-provisioning/language-server-provisioner.ts";
import type { LspPlatform } from "../../src/lsp-provisioning/lsp-platform.ts";
import type { GithubReleaseFixture } from "../support/github-release-fixture.ts";
import { startGithubReleaseFixture } from "../support/github-release-fixture.ts";
import type { NpmRegistryFixture } from "../support/npm-registry-fixture.ts";
import { startNpmRegistryFixture } from "../support/npm-registry-fixture.ts";

const LINUX_X64: LspPlatform = { os: "linux", arch: "x64", libc: "glibc" };

let root: string | undefined;
let npmFixture: NpmRegistryFixture | undefined;
let githubFixture: GithubReleaseFixture | undefined;
let cacheDir: string | undefined;

afterEach(() => {
	npmFixture?.stop();
	npmFixture = undefined;
	githubFixture?.stop();
	githubFixture = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
	cacheDir = undefined;
});

function freshLocation(): InstallLocation {
	root = mkdtempSync(join(tmpdir(), "lector-provisioner-"));
	return new InstallLocation(root);
}

/** A fresh, isolated npm cache per test -- npm's own content-addressed cache is keyed by integrity hash, not URL/port, so two tests installing byte-identical fixture content would otherwise silently skip the real network call these tests mean to observe. */
function freshNpmOptions(): { cacheDir: string } {
	cacheDir = mkdtempSync(join(tmpdir(), "lector-provisioner-npm-cache-"));
	return { cacheDir };
}

function buildTarGz(binName: string, content: string): Buffer {
	const workDir = mkdtempSync(join(tmpdir(), "lector-provisioner-tar-"));
	try {
		writeFileSync(join(workDir, binName), content, { mode: 0o755 });
		const tarballPath = join(workDir, "asset.tar.gz");
		execFileSync("tar", ["-czf", tarballPath, "-C", workDir, binName]);
		return readFileSync(tarballPath);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

describe("LanguageServerProvisioner", () => {
	it("installs an npm-distributed server end to end and returns a usable bin path", async () => {
		npmFixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "1.0.0",
			binName: "widget-lsp",
			binScriptContent: "#!/usr/bin/env node\nconsole.log('widget-lsp fixture');\n",
		});
		const location = freshLocation();
		const provisioner = new LanguageServerProvisioner(location, { npm: freshNpmOptions() });

		const outcome = await provisioner.ensureInstalled({
			id: "widget-lsp",
			source: { kind: "npm", packageName: "widget-lsp-fixture", binName: "widget-lsp", registry: npmFixture.url },
		});

		expect(outcome.kind).toBe("installed");
		if (outcome.kind !== "installed") throw new Error("expected installed");
		expect(existsSync(outcome.binPath)).toBe(true);
		expect(readFileSync(outcome.binPath, "utf8")).toContain("widget-lsp fixture");
		expect(outcome.receipt.resolvedVersion).toBe("1.0.0");
	}, 30_000);

	it("installs a github-release-distributed server end to end, deriving the bin name from binPathInArchive", async () => {
		const tarball = buildTarGz("zls", "#!/bin/sh\necho zls fixture\n");
		githubFixture = startGithubReleaseFixture({ repo: "zigtools/zls", tagName: "0.13.0", assets: [{ name: "zls-linux-x64.tar.gz", bytes: tarball }] });
		const location = freshLocation();
		const provisioner = new LanguageServerProvisioner(location, {
			githubRelease: { apiBaseUrl: githubFixture.apiBaseUrl },
			resolvePlatform: async () => LINUX_X64,
		});

		const outcome = await provisioner.ensureInstalled({
			id: "zls",
			source: { kind: "github-release", repo: "zigtools/zls", assetName: () => "zls-linux-x64.tar.gz", binPathInArchive: () => "zls" },
		});

		expect(outcome.kind).toBe("installed");
		if (outcome.kind !== "installed") throw new Error("expected installed");
		expect(readFileSync(outcome.binPath, "utf8")).toContain("zls fixture");
	}, 20_000);

	it("a second call is idempotent: no network touched, already-installed returned from the receipt", async () => {
		npmFixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "1.0.0",
			binName: "widget-lsp",
			binScriptContent: "#!/usr/bin/env node\n",
		});
		const location = freshLocation();
		const provisioner = new LanguageServerProvisioner(location, { npm: freshNpmOptions() });
		const spec = { id: "widget-lsp", source: { kind: "npm" as const, packageName: "widget-lsp-fixture", binName: "widget-lsp", registry: npmFixture.url } };

		const first = await provisioner.ensureInstalled(spec);
		expect(first.kind).toBe("installed");

		npmFixture.stop(); // the registry is now genuinely unreachable -- a second real network call would fail
		npmFixture = undefined;

		const second = await provisioner.ensureInstalled(spec);
		expect(second.kind).toBe("already-installed");
	}, 30_000);

	it("concurrent requests for the same missing package produce exactly one real install", async () => {
		npmFixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "1.0.0",
			binName: "widget-lsp",
			binScriptContent: "#!/usr/bin/env node\n",
		});
		const location = freshLocation();
		const provisioner = new LanguageServerProvisioner(location, { npm: freshNpmOptions() });
		const spec = { id: "widget-lsp", source: { kind: "npm" as const, packageName: "widget-lsp-fixture", binName: "widget-lsp", registry: npmFixture.url } };

		// Five genuinely concurrent callers for the identical spec.id -- the per-package in-flight
		// dedup map must collapse them onto the exact same install attempt, not race five real `npm
		// install` subprocesses. Verified structurally, not just "every outcome looked fine": the real
		// fixture registry's own tarball endpoint must have been hit exactly once.
		const results = await Promise.all(Array.from({ length: 5 }, () => provisioner.ensureInstalled(spec)));
		for (const outcome of results) expect(outcome.kind).toBe("installed");
		// Not npm's own tarball cache (which can mask a missing dedup by coincidentally reducing real
		// downloads below 5) -- versionLookupCount is exclusively Lector's own resolveNpmInstall call,
		// never touched by npm's CLI itself, so this is unaffected by npm's own caching.
		expect(npmFixture.versionLookupCount()).toBe(1);
		expect(npmFixture.tarballDownloadCount()).toBe(1);
	}, 30_000);

	it("does not hang past its own bounded timeout when the registry stalls indefinitely", async () => {
		const stallingServer = Bun.serve({
			port: 0,
			async fetch() {
				return new Promise(() => {}); // never resolves -- simulates a stalled network
			},
		});
		const location = freshLocation();
		const provisioner = new LanguageServerProvisioner(location, {
			npm: { registryClient: undefined },
		});

		const started = Date.now();
		const outcome = await provisioner.ensureInstalled({
			id: "widget-lsp",
			source: {
				kind: "npm",
				packageName: "widget-lsp-fixture",
				binName: "widget-lsp",
				registry: `http://127.0.0.1:${stallingServer.port}`,
			},
		});
		stallingServer.stop(true);

		expect(outcome.kind).toBe("unavailable");
		// NpmRegistryClient's own bounds default (10s timeoutMs, set in npm-installer.ts's
		// VERSION_RESOLUTION_BOUNDS) is what actually stops this -- proving it flows all the way
		// through the orchestrator's own ensureInstalled call, not just the client in isolation.
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 20_000);

	it("reports 'unavailable' rather than throwing for a genuinely missing package", async () => {
		npmFixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "1.0.0",
			binName: "widget-lsp",
			binScriptContent: "#!/usr/bin/env node\n",
		});
		const location = freshLocation();
		const provisioner = new LanguageServerProvisioner(location);

		const outcome = await provisioner.ensureInstalled({
			id: "does-not-exist",
			source: { kind: "npm", packageName: "this-package-was-never-published", binName: "x", registry: npmFixture.url },
		});

		expect(outcome.kind).toBe("unavailable");
	}, 20_000);
});
