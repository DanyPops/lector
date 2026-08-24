import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDirectUrlJson } from "./parsers/direct-url.ts";
import type { ParsedPythonEvidence } from "./parsers/shared.ts";
import { evidence } from "./parsers/shared.ts";
import { normalizePythonPackageName } from "./pep503.ts";
import type { PythonResolutionContext } from "./resolution-context.ts";

/** Every conventional venv directory name this project actually creates, in the order real tooling most commonly picks -- uv/Poetry both default to `.venv`; classic `python -m venv`/virtualenv workflows commonly use `venv`. Not an exhaustive list of every possible name a human could choose; a genuinely nonstandard venv location is out of scope for this bounded fallback. */
const VENV_DIRECTORY_NAMES = [".venv", "venv"] as const;
/** POSIX: lib/pythonX.Y/site-packages (version-specific, scanned as a glob). Windows: Lib/site-packages (no version segment). */
const POSIX_LIB_DIRECTORY = "lib";
const WINDOWS_SITE_PACKAGES = "Lib/site-packages";

const DIST_INFO_SUFFIX = ".dist-info";
/** `<name>-<version>.dist-info`, per PEP 427 -- the version segment never itself contains a literal hyphen, so splitting on the *last* hyphen before the suffix is unambiguous. */
const DIST_INFO_PATTERN = /^(.+)-([^-]+)$/;

function siteSitePackagesCandidates(projectRoot: string): readonly string[] {
	const candidates: string[] = [];
	for (const venvName of VENV_DIRECTORY_NAMES) {
		const venvRoot = join(projectRoot, venvName);
		if (!existsSync(venvRoot)) continue;
		candidates.push(join(venvRoot, WINDOWS_SITE_PACKAGES));
		const libDirectory = join(venvRoot, POSIX_LIB_DIRECTORY);
		if (!existsSync(libDirectory)) continue;
		for (const entry of readdirSync(libDirectory, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith("python")) candidates.push(join(libDirectory, entry.name, "site-packages"));
		}
	}
	return candidates;
}

/**
 * Scans a small, bounded set of conventional venv locations (`.venv`/`venv`, POSIX and Windows
 * layouts) for a `<name>-<version>.dist-info/direct_url.json` matching `packageName` under PEP
 * 503 normalization -- the fallback source of truth when no lockfile resolves the package at all
 * (an editable/direct-URL/direct-VCS install pip itself never records in any lockfile format).
 */
export function findDirectUrlEvidence(projectRoot: string, packageName: string, context: PythonResolutionContext): ParsedPythonEvidence | null {
	for (const sitePackages of siteSitePackagesCandidates(projectRoot)) {
		if (!existsSync(sitePackages)) continue;
		for (const entry of readdirSync(sitePackages, { withFileTypes: true })) {
			context.touchEntry();
			if (!entry.isDirectory() || !entry.name.endsWith(DIST_INFO_SUFFIX)) continue;
			const stem = entry.name.slice(0, -DIST_INFO_SUFFIX.length);
			const match = DIST_INFO_PATTERN.exec(stem);
			if (!match) continue;
			const [, distName, version] = match;
			if (distName === undefined || version === undefined || normalizePythonPackageName(distName) !== normalizePythonPackageName(packageName)) continue;
			const directUrlPath = join(sitePackages, entry.name, "direct_url.json");
			if (!existsSync(directUrlPath)) continue;
			const relativeLockfile = relativeWithinRoot(projectRoot, directUrlPath);
			const parsed = parseDirectUrlJson(context.readProjectFile(relativeLockfile), context);
			if (parsed === null) continue;
			return { version, evidence: evidence("pip", relativeLockfile, entry.name, parsed.kind, parsed.directSource, parsed.commit) };
		}
	}
	return null;
}

function relativeWithinRoot(root: string, absolutePath: string): string {
	// join(root, ...) constructed every candidate path above, so a plain prefix-strip is safe and
	// avoids importing node:path's relative() just for this one call site.
	return absolutePath.slice(root.length + 1).replaceAll("\\", "/");
}
