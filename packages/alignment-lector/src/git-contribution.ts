import { createHash } from "node:crypto";
import type { ContributionCommand, ContributionOutcome, ContributionReadBounds, ContributionResourceReference } from "@alignment/surface-protocol";
// Deep imports, not the "@danypops/lector" barrel -- see index.ts's own doc comment on why.
import { remoteErrorIs } from "@danypops/lector/src/client.ts";
import { type GitDiffFile, type GitDiffHunk, parseUnifiedGitDiff } from "@danypops/lector/src/git/unified-diff.ts";
import type { LectorOperations } from "./lector-operations.js";

export const GIT_COMMANDS = [
	{ id: "lector.git.status", title: "Show Git Status" },
	{ id: "lector.git.log", title: "Show Git Log" },
	{ id: "lector.git.diff", title: "Show Git Diff" },
	{ id: "lector.git.compare-symbol", title: "Compare Symbol Across Revisions" },
] as const;

const MAX_GIT_ENTRIES = 1_000;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
const MIN_GIT_BYTES = 64;
const MAX_CACHED_RESOURCES = 64;

type TruncationReason = "entries" | "bytes";

export interface GitOpenIntent {
	readonly commandId: "lector.file.open";
	readonly input: { readonly workspaceId: string; readonly path: string; readonly line?: number; readonly character?: number };
}

export interface GitHunkProjection {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly header: string;
	readonly lines: readonly string[];
	readonly open: GitOpenIntent | null;
}

export interface GitDiffFileProjection {
	readonly path: string;
	readonly previousPath?: string;
	readonly state: GitDiffFile["status"];
	readonly binary: boolean;
	readonly hunks: readonly GitHunkProjection[];
	readonly open: GitOpenIntent | null;
}

export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "ignored" | "conflicted";

export interface GitStatusFileProjection {
	readonly path: string;
	readonly previousPath?: string;
	readonly state: GitFileState;
	readonly staged: boolean;
	readonly unstaged: boolean;
	readonly open: GitOpenIntent | null;
}

interface CachedGitResource {
	readonly reference: ContributionResourceReference;
	readonly value: unknown;
	readonly bytes: number;
	readonly entries: number;
}

interface GitStatusOutput {
	readonly files: readonly { path: string; renamedFrom?: string; indexStatus: string; workingDirStatus: string }[];
	readonly ahead: number;
	readonly behind: number;
	readonly current: string | null;
	readonly tracking: string | null;
}

interface GitLogOutput {
	readonly entries: readonly { sha: string; authorName: string; authorEmail: string; authoredAt: string; message: string }[];
}

interface GitDiffOutput {
	readonly diff: string;
	readonly files: readonly GitDiffFile[];
	readonly truncated: boolean;
}

interface SymbolComparisonOutput {
	readonly path: string;
	readonly symbolName: string;
	readonly fromRef: string;
	readonly toRef: string;
	readonly status: "unchanged" | "changed" | "added" | "removed" | "both-missing";
	readonly diff: string;
	readonly truncated: boolean;
}

function failure(code: string, message: string): ContributionOutcome<never> {
	return { ok: false, code, message };
}

function record(value: unknown): Record<string, unknown> | undefined {
	// This assertion follows the runtime object/null check and assigns no field semantics.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function boundedInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

function validWorkspace(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validBytes(value: unknown): value is number {
	return boundedInteger(value, MAX_GIT_BYTES) && value >= MIN_GIT_BYTES;
}

function statusOutput(value: unknown): GitStatusOutput | undefined {
	const parsed = record(value);
	if (
		!parsed ||
		!Array.isArray(parsed.files) ||
		typeof parsed.ahead !== "number" ||
		typeof parsed.behind !== "number" ||
		!(typeof parsed.current === "string" || parsed.current === null) ||
		!(typeof parsed.tracking === "string" || parsed.tracking === null)
	)
		return undefined;
	const files: GitStatusOutput["files"][number][] = [];
	for (const candidate of parsed.files) {
		const file = record(candidate);
		if (!file || typeof file.path !== "string" || typeof file.indexStatus !== "string" || typeof file.workingDirStatus !== "string") return undefined;
		if (file.renamedFrom !== undefined && typeof file.renamedFrom !== "string") return undefined;
		files.push({
			path: file.path,
			...(typeof file.renamedFrom === "string" ? { renamedFrom: file.renamedFrom } : {}),
			indexStatus: file.indexStatus,
			workingDirStatus: file.workingDirStatus,
		});
	}
	return { files, ahead: parsed.ahead, behind: parsed.behind, current: parsed.current, tracking: parsed.tracking };
}

function logOutput(value: unknown): GitLogOutput | undefined {
	const parsed = record(value);
	if (!parsed || !Array.isArray(parsed.entries)) return undefined;
	const entries: GitLogOutput["entries"][number][] = [];
	for (const candidate of parsed.entries) {
		const entry = record(candidate);
		if (
			!entry ||
			typeof entry.sha !== "string" ||
			typeof entry.authorName !== "string" ||
			typeof entry.authorEmail !== "string" ||
			typeof entry.authoredAt !== "string" ||
			typeof entry.message !== "string"
		)
			return undefined;
		entries.push({ sha: entry.sha, authorName: entry.authorName, authorEmail: entry.authorEmail, authoredAt: entry.authoredAt, message: entry.message });
	}
	return { entries };
}

function hunkOutput(value: unknown): GitDiffHunk | undefined {
	const parsed = record(value);
	if (
		!parsed ||
		typeof parsed.oldStart !== "number" ||
		typeof parsed.oldLines !== "number" ||
		typeof parsed.newStart !== "number" ||
		typeof parsed.newLines !== "number" ||
		typeof parsed.header !== "string" ||
		!Array.isArray(parsed.lines) ||
		!parsed.lines.every((line) => typeof line === "string")
	)
		return undefined;
	return {
		oldStart: parsed.oldStart,
		oldLines: parsed.oldLines,
		newStart: parsed.newStart,
		newLines: parsed.newLines,
		header: parsed.header,
		lines: parsed.lines,
	};
}

function diffFileOutput(value: unknown): GitDiffFile | undefined {
	const parsed = record(value);
	if (
		!parsed ||
		typeof parsed.path !== "string" ||
		!(parsed.status === "modified" || parsed.status === "added" || parsed.status === "deleted" || parsed.status === "renamed" || parsed.status === "copied") ||
		typeof parsed.binary !== "boolean" ||
		!Array.isArray(parsed.hunks)
	)
		return undefined;
	if (parsed.previousPath !== undefined && typeof parsed.previousPath !== "string") return undefined;
	const hunks = parsed.hunks.map(hunkOutput);
	if (hunks.some((hunk) => !hunk)) return undefined;
	return {
		path: parsed.path,
		...(typeof parsed.previousPath === "string" ? { previousPath: parsed.previousPath } : {}),
		status: parsed.status,
		binary: parsed.binary,
		hunks: hunks.filter((hunk): hunk is GitDiffHunk => hunk !== undefined),
	};
}

function diffOutput(value: unknown): GitDiffOutput | undefined {
	const parsed = record(value);
	if (!parsed || typeof parsed.diff !== "string" || typeof parsed.truncated !== "boolean" || !Array.isArray(parsed.files)) return undefined;
	const files = parsed.files.map(diffFileOutput);
	if (files.some((file) => !file)) return undefined;
	return { diff: parsed.diff, truncated: parsed.truncated, files: files.filter((file): file is GitDiffFile => file !== undefined) };
}

function comparisonOutput(value: unknown): SymbolComparisonOutput | undefined {
	const parsed = record(value);
	if (
		!parsed ||
		typeof parsed.path !== "string" ||
		typeof parsed.symbolName !== "string" ||
		typeof parsed.fromRef !== "string" ||
		typeof parsed.toRef !== "string" ||
		!(
			parsed.status === "unchanged" ||
			parsed.status === "changed" ||
			parsed.status === "added" ||
			parsed.status === "removed" ||
			parsed.status === "both-missing"
		) ||
		typeof parsed.diff !== "string" ||
		typeof parsed.truncated !== "boolean"
	)
		return undefined;
	return {
		path: parsed.path,
		symbolName: parsed.symbolName,
		fromRef: parsed.fromRef,
		toRef: parsed.toRef,
		status: parsed.status,
		diff: parsed.diff,
		truncated: parsed.truncated,
	};
}

function openIntent(workspaceId: string, path: string, line?: number): GitOpenIntent {
	return {
		commandId: "lector.file.open",
		input: { workspaceId, path, ...(line === undefined ? {} : { line, character: 1 }) },
	};
}

function statusState(file: GitStatusOutput["files"][number]): GitFileState {
	const codes = `${file.indexStatus}${file.workingDirStatus}`;
	if (file.renamedFrom) return "renamed";
	if (codes.includes("U") || codes === "AA" || codes === "DD") return "conflicted";
	if (codes.includes("?")) return "untracked";
	if (codes.includes("!")) return "ignored";
	if (codes.includes("D")) return "deleted";
	if (codes.includes("A")) return "added";
	if (codes.includes("C")) return "copied";
	return "modified";
}

function projectHunk(workspaceId: string, path: string, deleted: boolean, hunk: GitDiffHunk): GitHunkProjection {
	return { ...hunk, open: deleted ? null : openIntent(workspaceId, path, Math.max(1, hunk.newStart)) };
}

function projectDiffFile(workspaceId: string, file: GitDiffFile): GitDiffFileProjection {
	const deleted = file.status === "deleted";
	return {
		path: file.path,
		...(file.previousPath ? { previousPath: file.previousPath } : {}),
		state: file.status,
		binary: file.binary,
		hunks: file.hunks.map((hunk) => projectHunk(workspaceId, file.path, deleted, hunk)),
		open: deleted ? null : openIntent(workspaceId, file.path),
	};
}

function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function resourceId(workspaceId: string, kind: string, input: unknown, value: unknown): string {
	return createHash("sha256").update(JSON.stringify({ workspaceId, kind, input, value })).digest("hex").slice(0, 24);
}

function resourceReference(workspaceId: string, kind: string, id: string, title: string): ContributionResourceReference {
	return { uri: `lector://${kind}/${encodeURIComponent(workspaceId)}?id=${id}`, kind, title, readOnly: true };
}

function errorOutcome(error: unknown): ContributionOutcome<never> {
	if (remoteErrorIs(error, "NotAGitRepository")) return failure("not-git-repository", "Workspace is not inside a Git repository");
	if (remoteErrorIs(error, "GitRevisionNotFound")) return failure("bad-revision", "Git revision does not exist");
	if (remoteErrorIs(error, "UnsafeGitArgument")) return failure("invalid-input", "Git revision is unsafe");
	if (remoteErrorIs(error, "SymbolComparisonUnsupportedLanguage"))
		return failure("unsupported-language", "Symbol comparison is unavailable for this file type");
	return failure("lector-error", error instanceof Error ? error.message : "Lector Git operation failed");
}

function withTruncation<T extends Record<string, unknown>, K extends string, E>(
	base: T,
	listKey: K,
	entries: readonly E[],
	maxEntries: number,
	maxBytes: number,
): T & Record<K, readonly E[]> & { truncated: boolean; truncatedBy: readonly TruncationReason[] } {
	const selected = entries.slice(0, maxEntries);
	const reasons: TruncationReason[] = entries.length > maxEntries ? ["entries"] : [];
	let value = { ...base, [listKey]: selected, truncated: reasons.length > 0, truncatedBy: reasons };
	while (encodedBytes(value) > maxBytes && selected.length > 0) {
		selected.pop();
		if (!reasons.includes("bytes")) reasons.push("bytes");
		value = { ...base, [listKey]: selected, truncated: true, truncatedBy: reasons };
	}
	// The computed key is the caller's literal K and always contains the selected E list.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as T & Record<K, readonly E[]> & { truncated: boolean; truncatedBy: readonly TruncationReason[] };
}

export interface GitContribution {
	readonly commands: readonly ContributionCommand[];
	registerWorkspace(workspaceId: string): void;
	read(reference: ContributionResourceReference, bounds: ContributionReadBounds): ContributionOutcome<unknown> | undefined;
	clear(): void;
}

export function createGitContribution(operations: LectorOperations): GitContribution {
	const workspaces = new Set<string>();
	const cache = new Map<string, CachedGitResource>();

	function cacheResource(workspaceId: string, kind: string, title: string, input: unknown, value: unknown, entries: number): ContributionResourceReference {
		const id = resourceId(workspaceId, kind, input, value);
		const reference = resourceReference(workspaceId, kind, id, title);
		cache.set(reference.uri, { reference, value, bytes: encodedBytes(value), entries });
		while (cache.size > MAX_CACHED_RESOURCES) cache.delete(cache.keys().next().value ?? "");
		return reference;
	}

	function workspaceInput(input: unknown): { parsed: Record<string, unknown>; workspaceId: string } | ContributionOutcome<never> {
		const parsed = record(input);
		if (!parsed || !validWorkspace(parsed.workspaceId) || !workspaces.has(parsed.workspaceId))
			return failure("invalid-input", "Git command requires an opened workspaceId");
		return { parsed, workspaceId: parsed.workspaceId };
	}

	const status: ContributionCommand = {
		...GIT_COMMANDS[0],
		async execute(input) {
			const workspace = workspaceInput(input);
			if ("ok" in workspace) return workspace;
			const { parsed, workspaceId } = workspace;
			if (!boundedInteger(parsed.maxEntries, MAX_GIT_ENTRIES) || !validBytes(parsed.maxBytes))
				return failure("invalid-input", "Git status requires bounded maxEntries and maxBytes");
			try {
				const output = statusOutput(await operations.call("workspace.gitStatus", { workspaceId }));
				if (!output) return failure("invalid-response", "Lector returned an invalid Git status");
				const files = output.files.map((file): GitStatusFileProjection => {
					const state = statusState(file);
					return {
						path: file.path,
						...(file.renamedFrom ? { previousPath: file.renamedFrom } : {}),
						state,
						staged: file.indexStatus !== " " && file.indexStatus !== "?",
						unstaged: file.workingDirStatus !== " ",
						open: state === "deleted" ? null : openIntent(workspaceId, file.path),
					};
				});
				const value = withTruncation(
					{
						kind: "git-status",
						workspaceId,
						branch: output.current === "HEAD" ? null : output.current,
						detached: output.current === null || output.current === "HEAD",
						tracking: output.tracking,
						ahead: output.ahead,
						behind: output.behind,
					},
					"files",
					files,
					parsed.maxEntries,
					parsed.maxBytes,
				);
				return { ok: true, value: cacheResource(workspaceId, "git-status", "Git Status", input, value, value.files.length) };
			} catch (error) {
				return errorOutcome(error);
			}
		},
	};

	const log: ContributionCommand = {
		...GIT_COMMANDS[1],
		async execute(input) {
			const workspace = workspaceInput(input);
			if ("ok" in workspace) return workspace;
			const { parsed, workspaceId } = workspace;
			if (!boundedInteger(parsed.maxCount, MAX_GIT_ENTRIES) || !validBytes(parsed.maxBytes))
				return failure("invalid-input", "Git log requires bounded maxCount and maxBytes");
			try {
				const output = logOutput(await operations.call("workspace.gitLog", { workspaceId, maxCount: Math.min(MAX_GIT_ENTRIES, parsed.maxCount + 1) }));
				if (!output) return failure("invalid-response", "Lector returned an invalid Git log");
				const value = withTruncation(
					{ kind: "git-log", workspaceId, revisions: { head: output.entries[0]?.sha ?? null } },
					"entries",
					output.entries,
					parsed.maxCount,
					parsed.maxBytes,
				);
				return { ok: true, value: cacheResource(workspaceId, "git-log", "Git Log", input, value, value.entries.length) };
			} catch (error) {
				return errorOutcome(error);
			}
		},
	};

	const diff: ContributionCommand = {
		...GIT_COMMANDS[2],
		async execute(input) {
			const workspace = workspaceInput(input);
			if ("ok" in workspace) return workspace;
			const { parsed, workspaceId } = workspace;
			if (!validBytes(parsed.maxBytes) || (parsed.ref !== undefined && typeof parsed.ref !== "string"))
				return failure("invalid-input", "Git diff requires a bounded maxBytes and optional revision");
			try {
				const output = diffOutput(
					await operations.call("workspace.gitDiff", { workspaceId, ...(parsed.ref ? { ref: parsed.ref } : {}), maxBytes: parsed.maxBytes }),
				);
				if (!output) return failure("invalid-response", "Lector returned an invalid Git diff");
				const files = output.files.map((file) => projectDiffFile(workspaceId, file));
				const value = {
					kind: "git-diff",
					workspaceId,
					revisions: { from: stringValue(parsed.ref) ?? "HEAD", to: "working tree" },
					files,
					truncated: output.truncated,
					truncatedBy: output.truncated ? (["bytes"] as const) : [],
				};
				const entries = files.reduce((count, file) => count + 1 + file.hunks.length, 0);
				return { ok: true, value: cacheResource(workspaceId, "git-diff", "Git Diff", input, value, entries) };
			} catch (error) {
				return errorOutcome(error);
			}
		},
	};

	const compareSymbol: ContributionCommand = {
		...GIT_COMMANDS[3],
		async execute(input) {
			const workspace = workspaceInput(input);
			if ("ok" in workspace) return workspace;
			const { parsed, workspaceId } = workspace;
			if (
				!validBytes(parsed.maxBytes) ||
				typeof parsed.path !== "string" ||
				parsed.path.length === 0 ||
				typeof parsed.symbolName !== "string" ||
				parsed.symbolName.length === 0 ||
				typeof parsed.fromRef !== "string" ||
				parsed.fromRef.length === 0 ||
				(parsed.toRef !== undefined && typeof parsed.toRef !== "string")
			)
				return failure("invalid-input", "Symbol comparison requires path, symbolName, fromRef, optional toRef, and bounded maxBytes");
			try {
				const output = comparisonOutput(
					await operations.call("workspace.compareSymbolAcrossVersions", {
						workspaceId,
						path: parsed.path,
						symbolName: parsed.symbolName,
						fromRef: parsed.fromRef,
						...(parsed.toRef ? { toRef: parsed.toRef } : {}),
						maxBytes: parsed.maxBytes,
					}),
				);
				if (!output) return failure("invalid-response", "Lector returned an invalid symbol comparison");
				const parsedDiff = parseUnifiedGitDiff(output.diff);
				const hunks = parsedDiff.flatMap((file) => file.hunks).map((hunk) => projectHunk(workspaceId, output.path, output.status === "removed", hunk));
				const value = {
					kind: "git-symbol-comparison",
					workspaceId,
					path: output.path,
					symbolName: output.symbolName,
					status: output.status,
					revisions: { from: output.fromRef, to: output.toRef },
					hunks,
					open: output.status === "removed" ? null : openIntent(workspaceId, output.path),
					truncated: output.truncated,
					truncatedBy: output.truncated ? (["bytes"] as const) : [],
				};
				return { ok: true, value: cacheResource(workspaceId, "git-symbol-comparison", `Compare ${output.symbolName}`, input, value, hunks.length) };
			} catch (error) {
				return errorOutcome(error);
			}
		},
	};

	return {
		commands: [status, log, diff, compareSymbol],
		registerWorkspace(workspaceId) {
			workspaces.add(workspaceId);
		},
		read(reference, bounds) {
			if (!reference.uri.startsWith("lector://git-")) return undefined;
			const cached = cache.get(reference.uri);
			if (!cached || cached.reference.kind !== reference.kind) return failure("resource-not-found", "Git resource is unavailable or expired");
			if (cached.entries > bounds.maxEntries || cached.bytes > bounds.maxBytes)
				return failure("resource-bound-exceeded", `Git resource requires ${cached.entries} entries and ${cached.bytes} bytes`);
			return { ok: true, value: cached.value };
		},
		clear() {
			workspaces.clear();
			cache.clear();
		},
	};
}
