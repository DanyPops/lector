/** The version-resolution and install-mechanics half of one provisioning attempt -- separate from staged-install.ts's own generic staging/commit orchestration, since the exact resolved version must be known (for the eventual receipt) independent of, and before, any files are staged. */
export interface ResolvedInstall {
	readonly resolvedVersion: string;
	/** Performs the real install work inside `stagingDir`; returns the installed binary's path relative to `stagingDir`. See StagedInstallInput.install's own doc comment for the failure-handling contract this must honor. */
	install(stagingDir: string): Promise<string>;
}
