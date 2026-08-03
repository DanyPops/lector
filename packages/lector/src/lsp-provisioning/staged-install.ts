import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InstallLocation } from "./install-location.ts";

export interface StagedInstallInput {
	readonly location: InstallLocation;
	readonly packageId: string;
	readonly binName: string;
	/** Performs the real install work inside `stagingDir` (download/extract, or `npm install --prefix`); returns the installed binary's path relative to `stagingDir`. Throwing here (including a kill mid-extraction) is caught by runStagedInstall -- nothing this returns or writes is ever trusted until it returns normally. */
	install(stagingDir: string): Promise<string>;
}

export interface StagedInstallResult {
	readonly binPath: string;
	readonly packageDir: string;
}

/**
 * Installs into an isolated staging directory first; only on `install()` returning normally is
 * the staging directory renamed into its real `packages/<id>` home and symlinked into `bin/` --
 * a single same-filesystem rename, so a reader either sees the old package directory or the
 * fully-installed new one, never a partial mix. Any failure (including a process killed mid-
 * extraction) removes the staging directory outright: nothing partially installed ever becomes
 * reachable via `bin/`, matching mason.nvim's own InstallRunner/linker split.
 */
export async function runStagedInstall(input: StagedInstallInput): Promise<StagedInstallResult> {
	mkdirSync(input.location.staging, { recursive: true });
	const stagingDir = mkdtempSync(join(input.location.staging, `${input.packageId}-`));
	try {
		const relativeBinPath = await input.install(stagingDir);
		const finalPackageDir = input.location.packageDir(input.packageId);
		mkdirSync(dirname(finalPackageDir), { recursive: true });
		rmSync(finalPackageDir, { recursive: true, force: true }); // reinstall: the old version is fully replaced, never merged with the new one
		renameSync(stagingDir, finalPackageDir);

		const finalBinPath = join(finalPackageDir, relativeBinPath);
		mkdirSync(input.location.bin, { recursive: true });
		const linkPath = input.location.binLink(input.binName);
		rmSync(linkPath, { force: true });
		symlinkSync(finalBinPath, linkPath);
		return { binPath: linkPath, packageDir: finalPackageDir };
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}
}
