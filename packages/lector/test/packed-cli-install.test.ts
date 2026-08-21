import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

async function run(command: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exitCode, stdout, stderr };
}

describe("published Lector CLI dependency closure", () => {
	it("packs, installs into an isolated prefix, resolves valid Vehicle floors, and starts through the bootstrap", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-packed-cli-"));
		const archiveDir = join(root, "archive");
		const prefix = join(root, "prefix");
		mkdirSync(archiveDir);
		const packageRoot = join(import.meta.dir, "..");
		const packed = await run(["npm", "pack", "--json", "--pack-destination", archiveDir], packageRoot);
		expect(packed.exitCode).toBe(0);
		const packages = JSON.parse(packed.stdout) as Array<{ filename: string }>;
		const packedPackage = packages[0];
		if (!packedPackage) throw new Error("npm pack returned no package");
		const installed = await run(
			["npm", "install", "--prefix", prefix, join(archiveDir, packedPackage.filename), "--ignore-scripts", "--no-audit", "--no-fund"],
			packageRoot,
		);
		expect(installed.exitCode).toBe(0);

		const version = await run([join(prefix, "node_modules", ".bin", "lector"), "--version"], prefix);
		expect(version).toMatchObject({ exitCode: 0, stderr: "" });
		const manifest = JSON.parse(readFileSync(join(prefix, "node_modules", "@danypops", "lector", "package.json"), "utf8")) as {
			version: string;
			bin: { lector: string };
		};
		expect(version.stdout.trim()).toBe(manifest.version);
		expect(manifest.bin.lector).toBe("src/cli-bootstrap.ts");

		const closure = await run(
			["npm", "ls", "--prefix", prefix, "--json", "@danypops/vehicle-client", "@danypops/vehicle-core", "@danypops/vehicle-server"],
			packageRoot,
		);
		expect(closure.exitCode).toBe(0);
	}, 120_000);
});
