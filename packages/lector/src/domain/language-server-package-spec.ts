import type { LspPlatform } from "./lsp-platform.ts";

/** An npm-distributed language server: `npm install <packageName>@<version>` puts `binName` on the resulting install's own bin/ directory (npm's package.json "bin" field, not guessed). */
export interface NpmLanguageServerSource {
	readonly kind: "npm";
	readonly packageName: string;
	readonly binName: string;
	/** A dist-tag ("latest") or exact semver. Defaults to "latest". */
	readonly version?: string;
	readonly registry?: string;
}

/**
 * A GitHub-release-distributed language server: one release asset per supported platform,
 * selected by `assetName`, extracted, with `binPathInArchive` naming the real executable's path
 * inside that archive (relative, forward-slash separated) once extracted.
 */
export interface GithubReleaseLanguageServerSource {
	readonly kind: "github-release";
	/** "owner/repo". */
	readonly repo: string;
	/** A tag name, or undefined for the latest release. */
	readonly tag?: string;
	/** Returns the exact release asset filename for `platform`, or undefined if this server has no build for it. */
	assetName(platform: LspPlatform): string | undefined;
	binPathInArchive(platform: LspPlatform): string;
}

export type LanguageServerSource = NpmLanguageServerSource | GithubReleaseLanguageServerSource;

/** What to install and how to identify it across repeated calls -- `id` is the stable key a receipt/lock/staging directory is keyed by, independent of the source's own version. */
export interface LanguageServerPackageSpec {
	readonly id: string;
	readonly source: LanguageServerSource;
}
