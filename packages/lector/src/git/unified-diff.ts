export type GitDiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface GitDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly header: string;
	readonly lines: readonly string[];
}

export interface GitDiffFile {
	readonly path: string;
	readonly previousPath?: string;
	readonly status: GitDiffFileStatus;
	readonly binary: boolean;
	readonly hunks: readonly GitDiffHunk[];
}

function unquotePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "/dev/null") return trimmed;
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function withoutSidePrefix(value: string): string {
	const path = unquotePath(value);
	return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function headerPaths(line: string): [string, string] | undefined {
	const match = /^diff --git (?:"a\/(.*)"|a\/(\S+)) (?:"b\/(.*)"|b\/(\S+))$/.exec(line);
	if (!match) return undefined;
	return [unquotePath(match[1] ?? match[2] ?? ""), unquotePath(match[3] ?? match[4] ?? "")];
}

function hunkRange(value: string | undefined): { start: number; lines: number } | undefined {
	if (!value) return undefined;
	const match = /^(\d+)(?:,(\d+))?$/.exec(value);
	if (!match) return undefined;
	return { start: Number(match[1]), lines: match[2] === undefined ? 1 : Number(match[2]) };
}

interface MutableFile {
	path: string;
	previousPath?: string;
	status: GitDiffFileStatus;
	binary: boolean;
	hunks: GitDiffHunk[];
}

/** Parses git's bounded unified-diff output once inside Lector so host integrations never duplicate Git syntax handling. */
export function parseUnifiedGitDiff(diff: string): readonly GitDiffFile[] {
	const files: MutableFile[] = [];
	let file: MutableFile | undefined;
	let oldPath: string | undefined;
	let newPath: string | undefined;
	const lines = diff.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.startsWith("diff --git ")) {
			const paths = headerPaths(line);
			file = { path: paths?.[1] ?? "", previousPath: paths?.[0], status: "modified", binary: false, hunks: [] };
			files.push(file);
			oldPath = paths?.[0];
			newPath = paths?.[1];
			continue;
		}
		if (!file && (line.startsWith("--- ") || line.startsWith("*** "))) {
			file = { path: "", status: "modified", binary: false, hunks: [] };
			files.push(file);
		}
		if (!file) continue;
		if (line.startsWith("rename from ")) {
			file.status = "renamed";
			file.previousPath = unquotePath(line.slice("rename from ".length));
			continue;
		}
		if (line.startsWith("rename to ")) {
			file.path = unquotePath(line.slice("rename to ".length));
			continue;
		}
		if (line.startsWith("copy from ")) {
			file.status = "copied";
			file.previousPath = unquotePath(line.slice("copy from ".length));
			continue;
		}
		if (line.startsWith("copy to ")) {
			file.path = unquotePath(line.slice("copy to ".length));
			continue;
		}
		if (line.startsWith("new file mode ")) file.status = "added";
		if (line.startsWith("deleted file mode ")) file.status = "deleted";
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			file.binary = true;
			continue;
		}
		if (line.startsWith("--- ")) {
			oldPath = withoutSidePrefix(line.slice(4));
			if (oldPath === "/dev/null") file.status = "added";
			continue;
		}
		if (line.startsWith("+++ ")) {
			newPath = withoutSidePrefix(line.slice(4));
			if (newPath === "/dev/null") file.status = "deleted";
			else file.path = newPath;
			if (oldPath && oldPath !== "/dev/null" && oldPath !== file.path) file.previousPath = oldPath;
			continue;
		}
		if (!line.startsWith("@@ ")) continue;
		const match = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line);
		const oldRange = hunkRange(match?.[1]);
		const newRange = hunkRange(match?.[2]);
		if (!match || !oldRange || !newRange) continue;
		const hunkLines: string[] = [];
		while (index + 1 < lines.length) {
			const candidate = lines[index + 1] ?? "";
			if (candidate.startsWith("diff --git ") || candidate.startsWith("@@ ")) break;
			hunkLines.push(candidate);
			index += 1;
		}
		file.hunks.push({
			oldStart: oldRange.start,
			oldLines: oldRange.lines,
			newStart: newRange.start,
			newLines: newRange.lines,
			header: match[3]?.trim() ?? "",
			lines: hunkLines,
		});
	}

	return files
		.filter((entry) => entry.path.length > 0)
		.map((entry) => ({
			path: entry.path,
			...(entry.previousPath && entry.previousPath !== entry.path ? { previousPath: entry.previousPath } : {}),
			status: entry.status,
			binary: entry.binary,
			hunks: entry.hunks,
		}));
}
