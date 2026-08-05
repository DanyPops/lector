import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_NPM_REGISTRY, NpmRegistryClient } from "../npm-registry/npm-registry-client.ts";
import type { NpmRegistryPort } from "../npm-registry/port.ts";
import { runBoundedSubprocess } from "./bounded-subprocess.ts";
import type { NpmLanguageServerSource } from "./language-server-package-spec.ts";
import type { ResolvedInstall } from "./resolved-install.ts";

const VERSION_RESOLUTION_BOUNDS = { maxResponseBytes: 4 * 1024 * 1024, maxRedirects: 5, maxRetries: 2, timeoutMs: 10_000 };
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

export class NpmInstallFailed extends Error {
	constructor(readonly detail: string) {
		super(`npm install failed: ${detail}`);
		this.name = "NpmInstallFailed";
	}
}

export class NpmInstallTimedOut extends Error {
	constructor() {
		super("npm install exceeded its bounded timeout");
		this.name = "NpmInstallTimedOut";
	}
}

export interface NpmInstallerOptions {
	readonly registryClient?: NpmRegistryPort;
	readonly npmCommand?: string;
	readonly installTimeoutMs?: number;
	/** Overrides npm's own cache directory (npm_config_cache) -- real provisioning wants npm's own default (repeat installs of a byte-identical version elsewhere benefit from it); tests set this to an isolated per-test directory so npm's content-addressed cache can never mask a missing dedup by silently skipping a real network request across unrelated test runs. */
	readonly cacheDir?: string;
}

/**
 * Resolves the exact version to install via Lector's own NpmRegistryClient (npm's own `/{name}/{tag-or-version}`
 * endpoint resolves a dist-tag like "latest" or an exact semver identically), then defers the actual
 * download+extract+dependency-resolution to a real `npm install --prefix <stagingDir>` -- not a hand-rolled
 * tarball fetch, since a real language server typically has its own npm dependencies a bare tarball
 * extraction would silently miss. `--no-save --no-package-lock` because the staging directory is never a
 * real npm project of its own; only its resulting node_modules/.bin/<binName> matters.
 */
export async function resolveNpmInstall(source: NpmLanguageServerSource, options: NpmInstallerOptions = {}): Promise<ResolvedInstall> {
	const client = options.registryClient ?? new NpmRegistryClient();
	const registry = source.registry ?? DEFAULT_NPM_REGISTRY;
	const metadata = await client.fetchVersion({ registry, name: source.packageName, version: source.version ?? "latest" }, VERSION_RESOLUTION_BOUNDS);
	const resolvedVersion = metadata.version;
	const npmCommand = options.npmCommand ?? "npm";
	const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

	return {
		resolvedVersion,
		install: async (stagingDir: string): Promise<string> => {
			const args = ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--prefix", stagingDir, `${source.packageName}@${resolvedVersion}`];
			if (source.registry) args.push("--registry", source.registry);
			const result = await runBoundedSubprocess(npmCommand, args, {
				timeoutMs: installTimeoutMs,
				cwd: stagingDir,
				env: options.cacheDir ? { npm_config_cache: options.cacheDir } : undefined,
			});
			if (result.timedOut) throw new NpmInstallTimedOut();
			if (result.code !== 0) throw new NpmInstallFailed(result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`);
			const relativeBinPath = join("node_modules", ".bin", source.binName);
			if (!existsSync(join(stagingDir, relativeBinPath))) {
				throw new NpmInstallFailed(`expected binary "${source.binName}" was not produced by npm install`);
			}
			return relativeBinPath;
		},
	};
}
