import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallLocation } from "../../src/lsp-provisioning/install-location.ts";
import { runStagedInstall } from "../../src/lsp-provisioning/staged-install.ts";

let root: string | undefined;

function freshLocation(): InstallLocation {
	root = mkdtempSync(join(tmpdir(), "lector-staged-install-"));
	return new InstallLocation(root);
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("runStagedInstall", () => {
	it("commits a successful install: bin/ symlinks to the real binary under packages/<id>", async () => {
		const location = freshLocation();
		const result = await runStagedInstall({
			location,
			packageId: "widget-lsp",
			binName: "widget-lsp",
			install: async (stagingDir) => {
				writeFileSync(join(stagingDir, "widget-lsp"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
				return "widget-lsp";
			},
		});

		expect(result.binPath).toBe(location.binLink("widget-lsp"));
		expect(existsSync(result.binPath)).toBe(true);
		expect(realpathSync(result.binPath)).toBe(join(location.packageDir("widget-lsp"), "widget-lsp"));
		expect(readFileSync(result.binPath, "utf8")).toContain("echo hi");
	});

	it("leaves no symlink and no package directory when install() throws mid-extraction", async () => {
		const location = freshLocation();
		await expect(
			runStagedInstall({
				location,
				packageId: "widget-lsp",
				binName: "widget-lsp",
				install: async (stagingDir) => {
					writeFileSync(join(stagingDir, "partial-file"), "half-extracted content");
					throw new Error("simulated: killed mid-extraction");
				},
			}),
		).rejects.toThrow("simulated: killed mid-extraction");

		expect(existsSync(location.binLink("widget-lsp"))).toBe(false);
		expect(existsSync(location.packageDir("widget-lsp"))).toBe(false);
		// The staging directory itself (and its partial content) must not survive either --
		// nothing partially installed lingers on disk to confuse a later listing/reinstall.
		expect(existsSync(location.staging) ? readdirSync(location.staging) : []).toEqual([]);
	});

	it("a reinstall fully replaces the previous package directory rather than merging with it", async () => {
		const location = freshLocation();
		await runStagedInstall({
			location,
			packageId: "widget-lsp",
			binName: "widget-lsp",
			install: async (stagingDir) => {
				writeFileSync(join(stagingDir, "widget-lsp"), "old version");
				writeFileSync(join(stagingDir, "stale-file-from-old-version"), "x");
				return "widget-lsp";
			},
		});

		await runStagedInstall({
			location,
			packageId: "widget-lsp",
			binName: "widget-lsp",
			install: async (stagingDir) => {
				writeFileSync(join(stagingDir, "widget-lsp"), "new version");
				return "widget-lsp";
			},
		});

		expect(readFileSync(location.binLink("widget-lsp"), "utf8")).toBe("new version");
		expect(existsSync(join(location.packageDir("widget-lsp"), "stale-file-from-old-version"))).toBe(false);
	});
});
