import { extname } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import { compareSymbolDeclarations } from "../code-intelligence/compare-symbol-declarations.ts";
import type { SymbolDeclarationSnapshot } from "../code-intelligence/symbol-declaration-snapshot.ts";
import { extractDeclarationSnapshot } from "../code-intelligence/tree-sitter/declaration-text.ts";
import { wasmPathForExtension } from "../code-intelligence/tree-sitter/typescript-parser.ts";
import type { GitPort } from "../git/port.ts";
import { NotAGitRepository, SymbolComparisonUnsupportedLanguage, SymbolQueryUnavailable, UnknownWorkspace, type WorkspaceId } from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { type MutableRegistry, resolveWorkspace } from "./workspace-registry.ts";

export interface GitHandlerDeps {
	readonly registry: MutableRegistry;
	readonly createGitPort: (rootPath: string) => GitPort;
	readonly logger: Logger;
}

export interface GitHandlers {
	"workspace.gitStatus": (registry: MutableRegistry, input: OperationInputs["workspace.gitStatus"]) => Promise<OperationOutputs["workspace.gitStatus"]>;
	"workspace.gitLog": (registry: MutableRegistry, input: OperationInputs["workspace.gitLog"]) => Promise<OperationOutputs["workspace.gitLog"]>;
	"workspace.gitDiff": (registry: MutableRegistry, input: OperationInputs["workspace.gitDiff"]) => Promise<OperationOutputs["workspace.gitDiff"]>;
	"workspace.gitShowFile": (registry: MutableRegistry, input: OperationInputs["workspace.gitShowFile"]) => Promise<OperationOutputs["workspace.gitShowFile"]>;
	"workspace.gitGrep": (registry: MutableRegistry, input: OperationInputs["workspace.gitGrep"]) => Promise<OperationOutputs["workspace.gitGrep"]>;
	"workspace.gitGrepHistory": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.gitGrepHistory"],
	) => Promise<OperationOutputs["workspace.gitGrepHistory"]>;
	"workspace.gitListFiles": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.gitListFiles"],
	) => Promise<OperationOutputs["workspace.gitListFiles"]>;
	"workspace.gitIsAncestor": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.gitIsAncestor"],
	) => Promise<OperationOutputs["workspace.gitIsAncestor"]>;
	"workspace.compareSymbolAcrossVersions": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.compareSymbolAcrossVersions"],
	) => Promise<OperationOutputs["workspace.compareSymbolAcrossVersions"]>;
}

/**
 * workspace.gitStatus/gitLog/gitDiff/gitShowFile/gitGrep/gitGrepHistory/gitListFiles/
 * gitIsAncestor/compareSymbolAcrossVersions -- every real git query, backed by GitPort.
 * gitShowFile/gitGrep/gitGrepHistory/gitListFiles/gitIsAncestor are Tier 1 of the cross-branch verification surface: real answers
 * about another ref's own tree with no checkout and no registered workspace of its own, unlike
 * gitWorktreeAdd's Tier 2 (a real, disposable project at that ref, for semantic queries).
 */
export function createGitHandlers(deps: GitHandlerDeps): GitHandlers {
	async function runGitOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error: unknown) {
			deps.logger.warn("git operation failed", {
				component: "git",
				operation,
				code: error instanceof Error ? error.name || "Error" : "Error",
			});
			throw error;
		}
	}

	/** Never cached: cheap to construct, and a stale-git-repo check would be wrong to memoize across a repo that could be git-init'd or removed mid-session. */
	async function requireGitRepository(workspaceId: WorkspaceId): Promise<GitPort> {
		const entry = deps.registry.get(workspaceId);
		if (!entry) throw new UnknownWorkspace(workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(workspaceId);
		const git = deps.createGitPort(entry.rootPath);
		if (!(await git.isGitRepository())) throw new NotAGitRepository(workspaceId);
		return git;
	}

	/** Undefined content (path not found at a ref) is a legitimate "missing" snapshot, never parsed -- only content that actually exists is worth running through tree-sitter. */
	async function declarationSnapshotAt(
		git: GitPort,
		workspaceId: WorkspaceId,
		path: string,
		extension: string,
		symbolName: string,
		ref: string | undefined,
	): Promise<SymbolDeclarationSnapshot> {
		const content =
			ref === undefined
				? await (async () => {
						const entry = await resolveWorkspace(deps.registry, workspaceId).readEntry(path);
						return entry.exists ? entry.content : undefined;
					})()
				: await git.showFile(ref, path);
		return content === undefined ? { found: false } : extractDeclarationSnapshot(content, extension, symbolName);
	}

	return {
		"workspace.gitStatus"(_registry, input) {
			return runGitOperation("workspace.gitStatus", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return git.status();
			});
		},
		"workspace.gitLog"(_registry, input) {
			return runGitOperation("workspace.gitLog", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return { entries: await git.log(input.maxCount) };
			});
		},
		"workspace.gitDiff"(_registry, input) {
			return runGitOperation("workspace.gitDiff", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return git.diff(input.ref, input.maxBytes);
			});
		},
		"workspace.gitShowFile"(_registry, input) {
			return runGitOperation("workspace.gitShowFile", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return { content: await git.showFile(input.ref, input.path) };
			});
		},
		"workspace.gitGrep"(_registry, input) {
			return runGitOperation("workspace.gitGrep", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return git.grep(input.ref, input.pattern, input.pathspecs, input.maxMatches, input.maxBytes);
			});
		},
		"workspace.gitGrepHistory"(_registry, input) {
			return runGitOperation("workspace.gitGrepHistory", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return git.grepHistory(input.pattern, input.pathspecs, {
					commitOffset: input.commitOffset,
					maxCommits: input.maxCommits,
					maxMatches: input.maxMatches,
					maxBytes: input.maxBytes,
					deadlineMs: input.deadlineMs,
				});
			});
		},
		"workspace.gitListFiles"(_registry, input) {
			return runGitOperation("workspace.gitListFiles", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return git.listFiles(input.ref, input.pathspecs, input.maxResults);
			});
		},
		"workspace.gitIsAncestor"(_registry, input) {
			return runGitOperation("workspace.gitIsAncestor", async () => {
				const git = await requireGitRepository(input.workspaceId);
				return { isAncestor: await git.isAncestor(input.ancestorRef, input.ref) };
			});
		},
		/**
		 * The syntactic tier only (git blob content run through tree-sitter, no real checkout, no
		 * project-aware LSP resolution across versions) -- see the task's own two-tier rationale for
		 * why this is the deliberate first pass, not a shortcut. `toRef` omitted compares against the
		 * current working tree via the same WorkspacePort every other read already goes through.
		 */
		"workspace.compareSymbolAcrossVersions"(_registry, input) {
			return runGitOperation("workspace.compareSymbolAcrossVersions", async () => {
				const extension = extname(input.path);
				if (!wasmPathForExtension(extension)) throw new SymbolComparisonUnsupportedLanguage(extension);
				const git = await requireGitRepository(input.workspaceId);
				const [from, to] = await Promise.all([
					declarationSnapshotAt(git, input.workspaceId, input.path, extension, input.symbolName, input.fromRef),
					declarationSnapshotAt(git, input.workspaceId, input.path, extension, input.symbolName, input.toRef),
				]);
				const toRef = input.toRef ?? "working tree";
				const comparison = compareSymbolDeclarations(input.path, input.symbolName, input.fromRef, toRef, from, to, input.maxBytes);
				return { path: input.path, symbolName: input.symbolName, fromRef: input.fromRef, toRef, ...comparison };
			});
		},
	};
}
