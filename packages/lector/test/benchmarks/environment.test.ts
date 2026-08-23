import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEnvironmentMetadata } from "../../benchmarks/harness/environment.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

describe("collectEnvironmentMetadata", () => {
	it("reports real Bun version, platform, arch, CPU count, and memory bounds regardless of git status", async () => {
		const env = await collectEnvironmentMetadata(process.cwd());

		expect(env.bunVersion).toBe(Bun.version);
		expect(env.platform).toBe(process.platform);
		expect(env.arch).toBe(process.arch);
		expect(env.cpuCount).toBeGreaterThan(0);
		expect(typeof env.cpuModel).toBe("string");
		expect(env.totalMemoryBytes).toBeGreaterThan(0);
		expect(env.freeMemoryBytes).toBeGreaterThan(0);
	});

	it("reports a real commit hash and a clean tree for a freshly committed repo", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-bench-env-"));
		try {
			git(root, "init", "-q");
			git(root, "config", "user.email", "t@t.com");
			git(root, "config", "user.name", "t");
			writeFileSync(join(root, "a.txt"), "hello\n");
			git(root, "add", "-A");
			git(root, "commit", "-q", "-m", "initial");

			const env = await collectEnvironmentMetadata(root);

			expect(env.gitCommit).toMatch(/^[0-9a-f]{40}$/);
			expect(env.gitDirty).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports gitDirty: true when the working tree has real uncommitted changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-bench-env-dirty-"));
		try {
			git(root, "init", "-q");
			git(root, "config", "user.email", "t@t.com");
			git(root, "config", "user.name", "t");
			writeFileSync(join(root, "a.txt"), "hello\n");
			git(root, "add", "-A");
			git(root, "commit", "-q", "-m", "initial");
			writeFileSync(join(root, "a.txt"), "changed\n");

			const env = await collectEnvironmentMetadata(root);

			expect(env.gitDirty).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports undefined git fields, not an error, for a directory that is not a git repository at all", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-bench-env-nongit-"));
		try {
			const env = await collectEnvironmentMetadata(root);

			expect(env.gitCommit).toBeUndefined();
			expect(env.gitDirty).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
