import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LspPlatform } from "../../src/domain/lsp-platform.ts";
import { GithubReleaseAssetUnavailable, GithubReleaseNotFound, resolveGithubReleaseInstall } from "../../src/lsp-provisioning/github-release-installer.ts";
import type { GithubReleaseFixture } from "../support/github-release-fixture.ts";
import { startGithubReleaseFixture } from "../support/github-release-fixture.ts";

const LINUX_X64: LspPlatform = { os: "linux", arch: "x64", libc: "glibc" };

let fixture: GithubReleaseFixture | undefined;
let stagingDir: string | undefined;
let workDir: string | undefined;

afterEach(() => {
	fixture?.stop();
	fixture = undefined;
	if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
	stagingDir = undefined;
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	workDir = undefined;
});

function buildRealTarGz(binName: string, content: string): Buffer {
	workDir = mkdtempSync(join(tmpdir(), "lector-github-fixture-src-"));
	writeFileSync(join(workDir, binName), content, { mode: 0o755 });
	const tarballPath = join(workDir, "asset.tar.gz");
	execFileSync("tar", ["-czf", tarballPath, "-C", workDir, binName]);
	return readFileSync(tarballPath);
}

describe("resolveGithubReleaseInstall", () => {
	it("resolves the latest release, downloads a .tar.gz asset matching the platform, and extracts it for real", async () => {
		const tarball = buildRealTarGz("zls", "#!/bin/sh\necho zls fixture\n");
		fixture = startGithubReleaseFixture({
			repo: "zigtools/zls",
			tagName: "0.13.0",
			assets: [{ name: "zls-linux-x64.tar.gz", bytes: tarball }],
		});
		stagingDir = mkdtempSync(join(tmpdir(), "lector-github-installer-"));

		const resolved = await resolveGithubReleaseInstall(
			{
				kind: "github-release",
				repo: "zigtools/zls",
				assetName: (platform) => (platform.os === "linux" && platform.arch === "x64" ? "zls-linux-x64.tar.gz" : undefined),
				binPathInArchive: () => "zls",
			},
			LINUX_X64,
			{ apiBaseUrl: fixture.apiBaseUrl },
		);
		expect(resolved.resolvedVersion).toBe("0.13.0");

		const relativeBinPath = await resolved.install(stagingDir);
		expect(relativeBinPath).toBe("zls");
		expect(readFileSync(join(stagingDir, relativeBinPath), "utf8")).toContain("zls fixture");
	}, 20_000);

	it("resolves a pinned tag rather than always latest", async () => {
		const tarball = buildRealTarGz("zls", "old version\n");
		fixture = startGithubReleaseFixture({ repo: "zigtools/zls", tagName: "0.11.0", assets: [{ name: "zls-linux-x64.tar.gz", bytes: tarball }] });

		const resolved = await resolveGithubReleaseInstall(
			{ kind: "github-release", repo: "zigtools/zls", tag: "0.11.0", assetName: () => "zls-linux-x64.tar.gz", binPathInArchive: () => "zls" },
			LINUX_X64,
			{ apiBaseUrl: fixture.apiBaseUrl },
		);
		expect(resolved.resolvedVersion).toBe("0.11.0");
	}, 20_000);

	it("installs a bare (non-archived) binary asset directly, chmod +x", async () => {
		fixture = startGithubReleaseFixture({
			repo: "acme/tool",
			tagName: "v1.0.0",
			assets: [{ name: "tool-linux-x64", bytes: Buffer.from("#!/bin/sh\necho bare binary\n") }],
		});
		stagingDir = mkdtempSync(join(tmpdir(), "lector-github-installer-"));

		const resolved = await resolveGithubReleaseInstall(
			{ kind: "github-release", repo: "acme/tool", assetName: () => "tool-linux-x64", binPathInArchive: () => "tool" },
			LINUX_X64,
			{ apiBaseUrl: fixture.apiBaseUrl },
		);
		const relativeBinPath = await resolved.install(stagingDir);
		const fullPath = join(stagingDir, relativeBinPath);
		expect(readFileSync(fullPath, "utf8")).toContain("bare binary");
	}, 20_000);

	it("throws GithubReleaseAssetUnavailable when no asset matches this platform", async () => {
		fixture = startGithubReleaseFixture({ repo: "zigtools/zls", tagName: "0.13.0", assets: [{ name: "zls-darwin-arm64.tar.gz", bytes: Buffer.from("x") }] });

		await expect(
			resolveGithubReleaseInstall({ kind: "github-release", repo: "zigtools/zls", assetName: () => undefined, binPathInArchive: () => "zls" }, LINUX_X64, {
				apiBaseUrl: fixture.apiBaseUrl,
			}),
		).rejects.toThrow(GithubReleaseAssetUnavailable);
	}, 20_000);

	it("throws GithubReleaseNotFound for a repo/tag with no matching release", async () => {
		fixture = startGithubReleaseFixture({ repo: "zigtools/zls", tagName: "0.13.0", assets: [] });

		await expect(
			resolveGithubReleaseInstall({ kind: "github-release", repo: "does-not/exist", assetName: () => "x", binPathInArchive: () => "x" }, LINUX_X64, {
				apiBaseUrl: fixture.apiBaseUrl,
			}),
		).rejects.toThrow(GithubReleaseNotFound);
	}, 20_000);
});
