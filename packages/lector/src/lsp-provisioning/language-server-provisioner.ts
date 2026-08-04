import { existsSync } from "node:fs";
import type { LanguageServerPackageSpec } from "../domain/language-server-package-spec.ts";
import type { LspPlatform } from "../domain/lsp-platform.ts";
import { resolveLspPlatform } from "../domain/lsp-platform.ts";
import type { ProvisionOutcome } from "../domain/provision-outcome.ts";
import { detectLibc } from "./detect-libc.ts";
import type { GithubReleaseInstallerOptions } from "./github-release-installer.ts";
import { resolveGithubReleaseInstall } from "./github-release-installer.ts";
import { InstallConcurrencyLimiter } from "./install-concurrency-limiter.ts";
import type { InstallLocation } from "./install-location.ts";
import type { NpmInstallerOptions } from "./npm-installer.ts";
import { resolveNpmInstall } from "./npm-installer.ts";
import type { LanguageServerProvisionerPort } from "./port.ts";
import { tryReadReceipt, writeReceipt } from "./receipt-store.ts";
import type { ResolvedInstall } from "./resolved-install.ts";
import { runStagedInstall } from "./staged-install.ts";

const DEFAULT_MAX_CONCURRENT_INSTALLS = 2;

export interface LanguageServerProvisionerOptions {
	readonly npm?: NpmInstallerOptions;
	readonly githubRelease?: GithubReleaseInstallerOptions;
	readonly maxConcurrentInstalls?: number;
	/** Injectable for tests -- real detection shells out to getconf/ldd and reads process.platform/arch. */
	readonly resolvePlatform?: () => Promise<LspPlatform>;
	readonly now?: () => string;
}

async function defaultResolvePlatform(): Promise<LspPlatform> {
	return resolveLspPlatform(process.platform, process.arch, await detectLibc());
}

/**
 * The mason-shaped orchestrator: idempotent (a receipt whose own binPath still exists on disk
 * short-circuits to "already-installed" with no network touched at all -- matching mason's own
 * behavior of never silently re-checking for updates on a plain "ensure installed" call),
 * race-safe per package (an in-flight-promise map, not a cross-process lockfile -- Lector runs
 * one daemon process per install root via its own single-instance daemon lock, so in-process
 * dedup gives the identical "exactly one real install" guarantee mason's own per-package
 * lockfile provides for its own multi-process usage, without needing file-lock machinery this
 * architecture doesn't require), and globally concurrency-bounded across every package via
 * InstallConcurrencyLimiter. Never throws: every stage's own bounded timeout (registry fetch,
 * install subprocess, release fetch/download/extract) already fails closed on its own, so
 * ensureInstalled's only job is to translate whatever comes back into a ProvisionOutcome a
 * caller can branch on without its own try/catch.
 */
export class LanguageServerProvisioner implements LanguageServerProvisionerPort {
	private readonly inFlight = new Map<string, Promise<ProvisionOutcome>>();
	private readonly limiter: InstallConcurrencyLimiter;
	private readonly resolvePlatform: () => Promise<LspPlatform>;
	private readonly now: () => string;
	private cachedPlatform: LspPlatform | undefined;

	constructor(
		private readonly location: InstallLocation,
		private readonly options: LanguageServerProvisionerOptions = {},
	) {
		this.limiter = new InstallConcurrencyLimiter(options.maxConcurrentInstalls ?? DEFAULT_MAX_CONCURRENT_INSTALLS);
		this.resolvePlatform = options.resolvePlatform ?? defaultResolvePlatform;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	async ensureInstalled(spec: LanguageServerPackageSpec): Promise<ProvisionOutcome> {
		const existing = this.inFlight.get(spec.id);
		if (existing) return existing;
		const attempt = this.runEnsureInstalled(spec).finally(() => this.inFlight.delete(spec.id));
		this.inFlight.set(spec.id, attempt);
		return attempt;
	}

	private async runEnsureInstalled(spec: LanguageServerPackageSpec): Promise<ProvisionOutcome> {
		const receipt = tryReadReceipt(this.location, spec.id);
		if (receipt && existsSync(receipt.binPath)) return { kind: "already-installed", binPath: receipt.binPath, receipt };

		const release = await this.limiter.acquire();
		try {
			const { resolved, platform } = await this.resolveInstall(spec);
			const binName =
				spec.source.kind === "npm"
					? spec.source.binName
					: binNameFromPath(spec.source.binPathInArchive(platform ?? (await this.resolvePlatform()), resolved.resolvedVersion));
			const staged = await runStagedInstall({
				location: this.location,
				packageId: spec.id,
				binName,
				install: resolved.install,
			});
			const newReceipt = {
				packageId: spec.id,
				source: spec.source,
				resolvedVersion: resolved.resolvedVersion,
				binPath: staged.binPath,
				installedAt: this.now(),
			};
			writeReceipt(this.location, newReceipt);
			return { kind: "installed", binPath: staged.binPath, receipt: newReceipt };
		} catch (error) {
			return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
		} finally {
			release();
		}
	}

	private async resolveInstall(spec: LanguageServerPackageSpec): Promise<{ resolved: ResolvedInstall; platform: LspPlatform | undefined }> {
		if (spec.source.kind === "npm") return { resolved: await resolveNpmInstall(spec.source, this.options.npm), platform: undefined };
		this.cachedPlatform ??= await this.resolvePlatform();
		return { resolved: await resolveGithubReleaseInstall(spec.source, this.cachedPlatform, this.options.githubRelease), platform: this.cachedPlatform };
	}
}

function binNameFromPath(path: string): string {
	const segments = path.split("/");
	return segments.at(-1) ?? path;
}
