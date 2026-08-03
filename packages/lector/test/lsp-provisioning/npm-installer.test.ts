import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpmInstallFailed, resolveNpmInstall } from "../../src/lsp-provisioning/npm-installer.ts";
import type { NpmRegistryFixture } from "../support/npm-registry-fixture.ts";
import { startNpmRegistryFixture } from "../support/npm-registry-fixture.ts";

let fixture: NpmRegistryFixture | undefined;
let stagingDir: string | undefined;
let cacheDir: string | undefined;

afterEach(() => {
	fixture?.stop();
	fixture = undefined;
	if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
	stagingDir = undefined;
	if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
	cacheDir = undefined;
});

/** A fresh, isolated npm cache per test -- npm's own content-addressed cache is keyed by integrity hash, not URL, so two tests installing byte-identical fixture content would otherwise silently skip the network call this test means to observe. */
function freshCacheDir(): string {
	cacheDir = mkdtempSync(join(tmpdir(), "lector-npm-cache-"));
	return cacheDir;
}

describe("resolveNpmInstall", () => {
	it("resolves the latest version and installs a real npm package via a real npm install, producing the expected bin path", async () => {
		fixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "1.2.3",
			binName: "widget-lsp",
			binScriptContent: "#!/usr/bin/env node\nconsole.log('widget-lsp fixture running');\n",
		});
		stagingDir = mkdtempSync(join(tmpdir(), "lector-npm-installer-"));

		const resolved = await resolveNpmInstall(
			{ kind: "npm", packageName: "widget-lsp-fixture", binName: "widget-lsp", registry: fixture.url },
			{ cacheDir: freshCacheDir() },
		);
		expect(resolved.resolvedVersion).toBe("1.2.3");

		const relativeBinPath = await resolved.install(stagingDir);
		expect(relativeBinPath).toBe(join("node_modules", ".bin", "widget-lsp"));
		const content = readFileSync(join(stagingDir, relativeBinPath), "utf8");
		expect(content).toContain("widget-lsp fixture running");
	}, 30_000);

	it("installs a pinned exact version rather than always resolving latest", async () => {
		fixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "2.0.0",
			binName: "widget-lsp",
			binScriptContent: "#!/usr/bin/env node\nconsole.log('v2');\n",
		});
		stagingDir = mkdtempSync(join(tmpdir(), "lector-npm-installer-"));

		const resolved = await resolveNpmInstall(
			{ kind: "npm", packageName: "widget-lsp-fixture", binName: "widget-lsp", version: "2.0.0", registry: fixture.url },
			{ cacheDir: freshCacheDir() },
		);
		expect(resolved.resolvedVersion).toBe("2.0.0");
	}, 30_000);

	it("throws NpmInstallFailed when the expected bin was never produced (a package that never declares that bin name)", async () => {
		fixture = startNpmRegistryFixture({
			packageName: "widget-lsp-fixture",
			version: "1.0.0",
			binName: "actual-bin-name",
			binScriptContent: "#!/usr/bin/env node\n",
		});
		stagingDir = mkdtempSync(join(tmpdir(), "lector-npm-installer-"));

		const resolved = await resolveNpmInstall(
			{ kind: "npm", packageName: "widget-lsp-fixture", binName: "wrong-bin-name", registry: fixture.url },
			{ cacheDir: freshCacheDir() },
		);

		await expect(resolved.install(stagingDir as string)).rejects.toThrow(NpmInstallFailed);
	}, 30_000);
});
