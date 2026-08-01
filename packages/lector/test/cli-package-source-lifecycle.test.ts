import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest } from "../src/domain/package-source.ts";
import type { PackageSourceResolverPort } from "../src/ports/package-source-resolver-port.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;
let projectRoot: string | undefined;
let sourceRoot: string | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	isolated?.cleanup();
	isolated = undefined;
	if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
	if (sourceRoot) rmSync(sourceRoot, { recursive: true, force: true });
	projectRoot = undefined;
	sourceRoot = undefined;
});

class FixedResolver implements PackageSourceResolverPort {
	resolve(request: PackageSourceRequest, _bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		return Promise.resolve({
			status: "verified",
			coordinate: { ...request.coordinate, resolvedVersion: "1.2.3" },
			repository: {
				url: "https://github.com/acme/widgets.git",
				requestedRef: "1111111111111111111111111111111111111111",
				resolvedRef: "1111111111111111111111111111111111111111",
				commit: "1111111111111111111111111111111111111111",
			},
			workspace: { cachePath: sourceRoot as string, origin: "fetched", readOnly: true },
			verification: { status: "verified", method: "registry-metadata-and-commit", integrity: "git:1111111111111111111111111111111111111111" },
		});
	}
}

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: {
			...process.env,
			XDG_DATA_HOME: isolated.root,
			XDG_STATE_HOME: isolated.root,
			XDG_RUNTIME_DIR: isolated.root,
			XDG_CONFIG_HOME: isolated.root,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

async function runCliExpectingFailure(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: {
			...process.env,
			XDG_DATA_HOME: isolated.root,
			XDG_STATE_HOME: isolated.root,
			XDG_RUNTIME_DIR: isolated.root,
			XDG_CONFIG_HOME: isolated.root,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode === 0) throw new Error("expected CLI to fail, but it exited 0");
	return stderr;
}

describe("lector CLI package-source lifecycle parity", () => {
	it("lists, then refuses removal of a still-registered source, through the authenticated daemon client", async () => {
		isolated = isolatedLectorPaths();
		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-package-project-"));
		sourceRoot = mkdtempSync(join(tmpdir(), "lector-cli-package-source-"));
		writeFileSync(join(sourceRoot, "index.ts"), "export const widget = 1;\n");
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createPackageSourceResolver: () => new FixedResolver(),
		});

		await runCli(["package", "source", projectRoot, "@scope/widget", "--version", "1.2.3"]);

		const listJson = JSON.parse(await runCli(["package", "list-sources", "--max-results", "10", "--json"])) as {
			entries: { name: string; resolvedVersion: string }[];
		};
		expect(listJson.entries).toHaveLength(1);
		expect(listJson.entries[0]?.name).toBe("@scope/widget");
		expect(listJson.entries[0]?.resolvedVersion).toBe("1.2.3");

		const listHuman = await runCli(["package", "list-sources", "--max-results", "10"]);
		expect(listHuman).toContain("@scope/widget@1.2.3");
		expect(listHuman.length).toBeLessThan(1_000);

		const removeStderr = await runCliExpectingFailure(["package", "remove-source", "npm", "@scope/widget", "1.2.3"]);
		expect(removeStderr).toMatch(/PackageSourceEntryInUse|still registered/);
	});

	it("reports removed:false for a coordinate that was never resolved", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createPackageSourceResolver: () => new FixedResolver(),
		});

		const json = JSON.parse(await runCli(["package", "remove-source", "npm", "never-resolved", "1.0.0", "--json"])) as { removed: boolean };
		expect(json.removed).toBe(false);

		const human = await runCli(["package", "remove-source", "npm", "never-resolved", "1.0.0"]);
		expect(human).toContain("not");
	});

	it("clean-sources reports removed/skipped counts, scoped to an ecosystem when given", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createPackageSourceResolver: () => new FixedResolver(),
		});

		const json = JSON.parse(await runCli(["package", "clean-sources", "--ecosystem", "npm", "--json"])) as { removed: number; skipped: number };
		expect(json.removed).toBe(0);
		expect(json.skipped).toBe(0);
	});
});
