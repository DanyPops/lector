import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
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

describe("lector CLI package-source parity", () => {
	it("returns exact JSON and bounded human output through the authenticated daemon client", async () => {
		isolated = isolatedLectorPaths();
		projectRoot = mkdtempSync(join(tmpdir(), "lector-cli-package-project-"));
		sourceRoot = mkdtempSync(join(tmpdir(), "lector-cli-package-source-"));
		writeFileSync(join(sourceRoot, "index.ts"), "export const widget = 1;\n");
		daemon = startLectorDaemon({
			workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
			paths: isolated.paths,
			createPackageSourceResolver: () => new FixedResolver(),
		});

		const json = JSON.parse(await runCli(["package", "source", projectRoot, "@scope/widget", "--version", "1.2.3", "--json"])) as {
			workspaceId: string;
			outcome: PackageSourceOutcome;
		};
		expect(json.workspaceId.length).toBeGreaterThan(0);
		expect(json.outcome.status).toBe("verified");

		const human = await runCli(["package", "source", projectRoot, "@scope/widget", "--version", "1.2.3"]);
		expect(human).toContain("@scope/widget@1.2.3");
		expect(human).toContain(sourceRoot);
		expect(human.length).toBeLessThan(1_000);
	});
});
