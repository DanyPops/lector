/**
 * Real environment metadata a benchmark artifact needs to be interpretable later: which commit
 * produced these numbers, whether the tree was clean, and what hardware/runtime measured them.
 * Never throws on a non-git directory -- git fields are simply omitted, since a benchmark run
 * against a fetched/vendored corpus outside any repository is a legitimate case, not an error.
 */
import { execFile } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EnvironmentMetadata {
	/** Full 40-character commit hash, or undefined when `cwd` is not inside a git repository. */
	readonly gitCommit: string | undefined;
	/** true when `git status --porcelain` reports any change, undefined when not a git repository. */
	readonly gitDirty: boolean | undefined;
	readonly bunVersion: string;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly cpuCount: number;
	readonly cpuModel: string;
	readonly totalMemoryBytes: number;
	readonly freeMemoryBytes: number;
}

async function tryGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", [...args], { cwd });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

/** Collects real environment metadata for a benchmark run against the repository/directory at `cwd`. */
export async function collectEnvironmentMetadata(cwd: string): Promise<EnvironmentMetadata> {
	const gitCommit = await tryGit(cwd, ["rev-parse", "HEAD"]);
	const gitStatus = gitCommit === undefined ? undefined : await tryGit(cwd, ["status", "--porcelain"]);
	const cpuInfo = cpus();

	return {
		gitCommit: gitCommit && /^[0-9a-f]{40}$/.test(gitCommit) ? gitCommit : undefined,
		gitDirty: gitCommit === undefined ? undefined : (gitStatus?.length ?? 0) > 0,
		bunVersion: Bun.version,
		platform: process.platform,
		arch: process.arch,
		cpuCount: cpuInfo.length,
		cpuModel: cpuInfo[0]?.model ?? "unknown",
		totalMemoryBytes: totalmem(),
		freeMemoryBytes: freemem(),
	};
}
