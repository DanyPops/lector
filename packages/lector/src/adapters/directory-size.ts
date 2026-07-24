import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Real on-disk size in bytes via `du -sb`, not a hand-rolled recursive stat sum -- `du` already
 * handles hard links and sparse files correctly, a walker built from scratch would not.
 * Linux-only (GNU coreutils `-b`), matching this codebase's existing /proc-based RSS measurement.
 */
export async function measureDirectorySizeBytes(path: string): Promise<number> {
	const { stdout } = await execFileAsync("du", ["-sb", path]);
	const [sizeText] = stdout.split("\t");
	const size = Number.parseInt(sizeText ?? "", 10);
	if (!Number.isFinite(size)) {
		throw new Error(`du produced unparseable output for ${path}: ${JSON.stringify(stdout)}`);
	}
	return size;
}
