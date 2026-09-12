import { isAbsolute, relative } from "node:path";

const DEPENDENCY_DIRECTORIES = new Set(["node_modules", "vendor", ".venv", "venv", "site-packages", ".git", ".bun", "__pycache__"]);

/** Returns a portable path for workspace-owned source, excluding dependencies and parent escapes. */
export function localizedPath(root: string, path: string): string | undefined {
	const pathFromRoot = relative(root, path).replaceAll("\\", "/");
	if (!pathFromRoot || isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith("../")) return undefined;
	if (pathFromRoot.split("/").some((part) => DEPENDENCY_DIRECTORIES.has(part))) return undefined;
	return pathFromRoot;
}
