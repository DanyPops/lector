import { relative } from "node:path";

/**
 * Convert an absolute path pi's tools pass to Lector's workspace-relative
 * form. The workspace root *is* the tool's cwd (registered via
 * workspace.registerPath), so this is a plain node:path relative() --
 * LocalFilesystemWorkspace independently rejects anything that still
 * escapes its own root, but failing fast here gives a clearer error at the
 * Pi-tool boundary instead of a generic PathEscapesWorkspaceRoot later.
 */
export function toWorkspaceRelativePath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	if (rel.startsWith("..")) {
		throw new Error(`path "${absolutePath}" is outside the Lector-registered workspace root "${cwd}"`);
	}
	return rel;
}
