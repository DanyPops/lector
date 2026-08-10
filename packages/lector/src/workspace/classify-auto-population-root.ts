import { sep } from "node:path";

/**
 * Filenames that mark a directory as a real project worth auto-indexing -- checked at the
 * resolved root itself, not searched recursively (a recursive search is exactly the expensive
 * walk this gate exists to prevent). Deliberately generous across languages already shipped
 * (TypeScript/JavaScript, Python, Go, Rust, C/C++) plus the widely-recognized JVM/Ruby/PHP/.NET
 * markers, so a real project in any of these ecosystems is never mistaken for a broad root.
 */
const PROJECT_MARKER_FILENAMES: readonly string[] = [
	".git",
	"package.json",
	"go.mod",
	"Cargo.toml",
	"pyproject.toml",
	"setup.py",
	"Gemfile",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"composer.json",
	"Makefile",
	"CMakeLists.txt",
];

export interface ClassifyAutoPopulationRootInput {
	readonly rootPath: string;
	readonly homeDir: string;
	/** The resolved root's own top-level entry names -- a caller-supplied listing, not an I/O call this function makes itself. */
	readonly topLevelEntries: readonly string[];
}

export type AutoPopulationRootClassification = "real-project" | "broad-non-project";

function hasProjectMarker(topLevelEntries: readonly string[]): boolean {
	const names = new Set(topLevelEntries);
	return PROJECT_MARKER_FILENAMES.some((marker) => names.has(marker));
}

/** True when rootPath IS homeDir, or any path segment between homeDir and rootPath starts with "." -- catches ~/.config, ~/.cache, ~/.local/share, ~/.pi/agent, and homeDir itself, without hard-coding every XDG/tool-specific directory name by hand. */
function isUnderADotSegmentOfHome(rootPath: string, homeDir: string): boolean {
	const normalizedHome = homeDir.endsWith(sep) ? homeDir.slice(0, -1) : homeDir;
	if (rootPath === normalizedHome) return true;
	if (!rootPath.startsWith(`${normalizedHome}${sep}`)) return false;
	const relative = rootPath.slice(normalizedHome.length + 1);
	return relative.split(sep).some((segment) => segment.startsWith("."));
}

/**
 * Decides whether a resolved workspace root looks like a real project worth auto-indexing, or a
 * broad host directory (the user's home directory, an XDG config/cache/data root, a dotfile
 * directory like ~/.pi) that happened to resolve here only because path-or-directory/
 * given-directory correctly fell back to "the directory itself" when no project marker was
 * found walking up. A real project marker at the root always wins -- someone genuinely keeping a
 * git repo directly under a dotfile directory (e.g. ~/.dotfiles) is not penalized for its name.
 */
export function classifyAutoPopulationRoot(input: ClassifyAutoPopulationRootInput): AutoPopulationRootClassification {
	if (hasProjectMarker(input.topLevelEntries)) return "real-project";
	if (isUnderADotSegmentOfHome(input.rootPath, input.homeDir)) return "broad-non-project";
	return "real-project";
}
