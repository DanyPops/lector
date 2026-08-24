/**
 * PEP 503 package-name normalization -- the rule every Python packaging tool (pip, PyPI itself,
 * uv, Poetry) applies before comparing two package names: lowercase, and any run of `-`, `_`, or
 * `.` collapses to a single `-`. Two differently-spelled references to the same real package
 * (e.g. "Friendly_Bard" in one lockfile, "friendly-bard" in another) must compare equal.
 */
export function normalizePythonPackageName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_.]+/g, "-");
}
