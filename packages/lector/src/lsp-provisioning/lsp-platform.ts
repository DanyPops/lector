export type LspOperatingSystem = "linux" | "darwin" | "win32";
export type LspArchitecture = "x64" | "arm64" | "x86" | "arm";
export type LibcVariant = "glibc" | "musl";

/**
 * The platform signature a GitHub-release-distributed language server's asset name must match.
 * `libc` is undefined on darwin/win32 (the distinction is meaningless there) and also undefined
 * on linux when detection itself is inconclusive -- an asset matcher that requires a specific
 * libc must treat "undefined" as "cannot confirm a match", never silently assume glibc.
 */
export interface LspPlatform {
	readonly os: LspOperatingSystem;
	readonly arch: LspArchitecture;
	readonly libc: LibcVariant | undefined;
}

const SUPPORTED_OS: readonly LspOperatingSystem[] = ["linux", "darwin", "win32"];

function isSupportedOs(value: string): value is LspOperatingSystem {
	return (SUPPORTED_OS as readonly string[]).includes(value);
}

const ARCH_ALIASES: Record<string, LspArchitecture> = {
	x64: "x64",
	arm64: "arm64",
	ia32: "x86",
	arm: "arm",
};

export class UnsupportedLspPlatform extends Error {
	constructor(
		readonly platform: string,
		readonly arch: string,
	) {
		super(`unsupported platform for language-server provisioning: ${platform}/${arch}`);
		this.name = "UnsupportedLspPlatform";
	}
}

/**
 * Resolves the current host's platform signature for asset matching. `detectLibc` is injected
 * (real detection shells out to getconf/ldd, an adapter concern -- see detect-libc.ts) so this
 * stays synchronous and trivially testable against every OS/arch combination from any host.
 */
export function resolveLspPlatform(nodePlatform: NodeJS.Platform, nodeArch: string, libc: LibcVariant | undefined): LspPlatform {
	if (!isSupportedOs(nodePlatform)) throw new UnsupportedLspPlatform(nodePlatform, nodeArch);
	const arch = ARCH_ALIASES[nodeArch];
	if (!arch) throw new UnsupportedLspPlatform(nodePlatform, nodeArch);
	return { os: nodePlatform, arch, libc: nodePlatform === "linux" ? libc : undefined };
}
