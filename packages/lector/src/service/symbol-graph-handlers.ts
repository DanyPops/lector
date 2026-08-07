import { extname } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { DocumentSymbolEntry } from "../code-intelligence/document-symbol.ts";
import { documentSymbols as documentSymbolsQuery } from "../code-intelligence/document-symbols.ts";
import { findReferences as findReferencesQuery } from "../code-intelligence/find-references.ts";
import { LANGUAGE_SERVER_DESCRIPTORS } from "../code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceDescriptors } from "../code-intelligence/lsp/discover-seed-file.ts";
import { findImportSpecifiers } from "../code-intelligence/tree-sitter/import-specifiers.ts";
import type { BoundedJobExecutor } from "../concurrency/bounded-job-executor.ts";
import type { SerialExecutionQueue } from "../concurrency/serial-execution-queue.ts";
import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import type { GitPort } from "../git/port.ts";
import { applyReferenceBasedRename } from "../reference-based-rename/apply-reference-based-rename.ts";
import { planReferenceBasedRename } from "../reference-based-rename/reference-based-rename.ts";
import { isCacheFreshByGit } from "../repo-fetcher/git-cache-freshness.ts";
import type { RepoFetcherPort } from "../repo-fetcher/port.ts";
import { shouldRefetchFromRemote } from "../repo-fetcher/remote-cache-freshness.ts";
import { computeUpdatedFileContentHashes } from "../symbol-graph/compute-updated-file-content-hashes.ts";
import { findDependentFiles } from "../symbol-graph/find-dependent-files.ts";
import { mergePopulationResult } from "../symbol-graph/merge-population-result.ts";
import { type PopulateSymbolGraphResult, populateSymbolGraph as populateSymbolGraphQuery } from "../symbol-graph/populate-symbol-graph.ts";
import { purgeFilesNoLongerWalked } from "../symbol-graph/purge-stale-graph-entries.ts";
import { reachableSymbolsFrom } from "../symbol-graph/reachable-symbols-from.ts";
import { diffFileHashes } from "../symbol-graph/select-files-to-reprocess.ts";
import { symbolEdgesFrom } from "../symbol-graph/symbol-edges-from.ts";
import { symbolEdgesTo } from "../symbol-graph/symbol-edges-to.ts";
import type { SymbolGraphGeneration } from "../symbol-graph/symbol-graph-generation.ts";
import { deriveSymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import { applyWorkspaceEdit, collectTouchedPaths } from "../workspace/apply-workspace-edit.ts";
import { WorkspaceEntryNotFound } from "../workspace/raw-read.ts";
import { deriveSourceManifest } from "../workspace/source-manifest.ts";
import type { ParsedWorkspaceEdit } from "../workspace/workspace-edit.ts";
import { MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP, MAX_INITIAL_JOB_WAIT_MS, MAX_SOURCE_MANIFEST_BYTES, POPULATION_CONCURRENCY } from "./bounds.ts";
import { requireCodeIntelligence } from "./code-intelligence-handlers.ts";
import {
	CodeIntelligenceUnavailable,
	InvalidJobInput,
	JobWaitTooLong,
	jobTopicFor,
	jobWatchIdFor,
	ReferenceBasedRenameRequiresFreshGraph,
	RenameNotSupported,
	SymbolQueryUnavailable,
	UnknownWorkspace,
	UnsupportedJobOperation,
	WorkspaceChangedDuringPopulation,
	type WorkspaceId,
} from "./errors.ts";
import type { GraphRefreshCoordinator } from "./graph-refresh-coordinator.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { supportsCodeIntelligence, type WarmIndexRegistry } from "./warm-index-registry.ts";
import type { MutableRegistry, RegisteredWorkspace } from "./workspace-registry.ts";

export interface SymbolGraphHandlerDeps {
	readonly registry: MutableRegistry;
	readonly warmIndexes: WarmIndexRegistry<WorkspaceId>;
	readonly graphRefresh: GraphRefreshCoordinator<WorkspaceId, string>;
	readonly repoFetcher: RepoFetcherPort | undefined;
	readonly createGitPort: (rootPath: string) => GitPort;
	readonly jobs: BoundedJobExecutor<PopulateSymbolGraphResult>;
	readonly logger: Logger;
	readonly renameMutationBarrier: SerialExecutionQueue;
	readonly publish: (topic: string, payload: unknown) => void;
	/** Late-bound: WorkspaceWatchHandlers and this factory are mutually dependent (this needs
	 * ensureOsWatcher, WorkspaceWatchHandlers needs scheduleGraphRefresh below) -- the caller
	 * passes an initially-no-op indirection and rebinds it once both objects exist. */
	readonly ensureOsWatcher: (workspaceId: WorkspaceId, rootPath: string) => void;
}

export interface SymbolGraphHandlers {
	"workspace.populateSymbolGraph": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	) => Promise<OperationOutputs["workspace.populateSymbolGraph"]>;
	"workspace.cacheStatus": (registry: MutableRegistry, input: OperationInputs["workspace.cacheStatus"]) => Promise<OperationOutputs["workspace.cacheStatus"]>;
	"workspace.referenceBasedRename": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	) => Promise<OperationOutputs["workspace.referenceBasedRename"]>;
	"workspace.prepareRename": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.prepareRename"],
	) => Promise<OperationOutputs["workspace.prepareRename"]>;
	"workspace.rename": (registry: MutableRegistry, input: OperationInputs["workspace.rename"]) => Promise<OperationOutputs["workspace.rename"]>;
	"workspace.reachableFrom": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	) => Promise<OperationOutputs["workspace.reachableFrom"]>;
	"workspace.symbolEdgesFrom": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	) => Promise<OperationOutputs["workspace.symbolEdgesFrom"]>;
	"workspace.symbolEdgesTo": (
		registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	) => Promise<OperationOutputs["workspace.symbolEdgesTo"]>;
	"job.submit": (registry: MutableRegistry, request: OperationInputs["job.submit"]) => Promise<OperationOutputs["job.submit"]>;
	"job.status": (registry: MutableRegistry, input: OperationInputs["job.status"]) => Promise<OperationOutputs["job.status"]>;
	"job.watch": (registry: MutableRegistry, input: OperationInputs["job.watch"]) => Promise<OperationOutputs["job.watch"]>;
}

export interface SymbolGraphHandlerFactory {
	readonly handlers: SymbolGraphHandlers;
	/**
	 * Submits a fresh background population for `workspaceId` using its last generation's own
	 * bounds, deduplicated against any already-in-flight population the same way job.submit's
	 * own dedup works. Exposed standalone (not just reachable through `handlers`) because
	 * WorkspaceWatchHandlers calls it directly on every relevant file change, not through dispatch.
	 */
	scheduleGraphRefresh(workspaceId: WorkspaceId): Promise<void>;
}

/**
 * The genuinely entangled cluster the SOLID mitigation originally deferred: symbol-graph
 * population/cache-status, rename/referenceBasedRename (both need a fully-cached graph),
 * reachable-from/symbol-edges (pure graph reads), and the background-job admin trio (the only
 * job type is workspace.populateSymbolGraph). What made this risky before -- symbolIndexes/
 * ensureWarmIndex touched from 10+ call sites -- now lives in WarmIndexRegistry/
 * GraphRefreshCoordinator, passed in here as already-built collaborators rather than raw
 * closure state.
 */
export function createSymbolGraphHandlers(deps: SymbolGraphHandlerDeps): SymbolGraphHandlerFactory {
	const { registry, warmIndexes, graphRefresh, repoFetcher, createGitPort, jobs, logger, renameMutationBarrier, publish, ensureOsWatcher } = deps;
	const ensureSymbolGraph = (workspaceId: WorkspaceId) => graphRefresh.graph(workspaceId);

	/**
	 * The git HEAD sha to record with a fresh generation, or undefined when the workspace isn't
	 * a git repository or its tree wasn't clean at population time -- either way, no single sha
	 * can honestly represent "the state this generation was built from." Never throws: any git
	 * error just means this workspace's future cache-status checks always pay for a full rehash,
	 * not that population itself should fail.
	 */
	async function captureGitHeadShaIfClean(rootPath: string): Promise<string | undefined> {
		try {
			const git = createGitPort(rootPath);
			if (!(await git.isGitRepository())) return undefined;
			const status = await git.status();
			if (status.files.length > 0) return undefined;
			const [latest] = await git.log(1);
			return latest?.sha;
		} catch {
			return undefined;
		}
	}

	/**
	 * False on any git error, not just a genuine mismatch -- an errored fast-path check must
	 * never be trusted as "fresh," only ever fall back to the full rehash. Deliberately skips a
	 * separate isGitRepository() probe: status()/log() on a non-repo fail on their own, caught
	 * the same way, at one fewer subprocess spawn -- confirmed to matter empirically (a real
	 * measured ~20% of this check's own cost at production-relevant tree sizes), not a guessed
	 * micro-optimization.
	 */
	async function isCacheFreshViaGit(rootPath: string, recordedHeadSha: string): Promise<boolean> {
		try {
			const git = createGitPort(rootPath);
			const status = await git.status();
			const [latest] = await git.log(1);
			return isCacheFreshByGit({ recordedHeadSha, isGitRepository: true, workingTreeClean: status.files.length === 0, currentHeadSha: latest?.sha });
		} catch {
			return false;
		}
	}

	/**
	 * Closes and forgets any warm symbol index for this workspace, without touching another
	 * workspace's. Called after a forced remote refetch replaces the workspace's on-disk
	 * directory wholesale -- an already-warm LSP process (e.g. tsserver) has its own project
	 * state built from the old directory and does not recover from having it swapped out from
	 * under it (confirmed live: querying it afterwards failed with "No Project"). The next
	 * ensureLanguageIndex call for this workspace spawns a fresh process against the new content.
	 */
	async function closeWarmIndexesForWorkspace(workspaceId: WorkspaceId): Promise<void> {
		await warmIndexes.closeWorkspace(workspaceId);
	}

	/**
	 * Auto-pull, on demand, no debounce: every call against a remote-tracked workspace pays one
	 * cheap ls-remote; a real refetch only happens on the call where the remote's commit actually
	 * differs from what the last generation recorded. A no-op for a local workspace, a remote
	 * workspace with no prior generation to compare against, or an inconclusive remote check
	 * (shouldRefetchFromRemote never treats "couldn't tell" as evidence of staleness). The
	 * refetch reuses repoFetcher's own atomic clone-into-tmp-then-rename swap at the exact same
	 * on-disk path this workspace is already registered against, so no registry update is needed
	 * -- the next read of rootPath simply sees the fresh content.
	 */
	async function refreshRemoteWorkspaceIfMoved(
		workspaceId: WorkspaceId,
		entry: RegisteredWorkspace,
		previousGeneration: SymbolGraphGeneration | undefined,
	): Promise<void> {
		if (!entry.remoteReference || !repoFetcher) return;
		const currentRemoteCommit = await repoFetcher.resolveRemoteCommit(entry.remoteReference);
		if (!shouldRefetchFromRemote({ recordedCommit: previousGeneration?.remoteCommit, currentRemoteCommit })) return;
		await repoFetcher.fetch(entry.remoteReference, { forceRefresh: true });
		await closeWarmIndexesForWorkspace(workspaceId);
	}

	async function populateSymbolGraphHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.populateSymbolGraph"],
	): Promise<OperationOutputs["workspace.populateSymbolGraph"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry?.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const rootPath = entry.rootPath;
		const graph = ensureSymbolGraph(input.workspaceId);
		// Purge before repopulating: a file walked last generation but absent from this one was
		// deleted (or moved out of scope), and its stale nodes/edges must not survive indefinitely.
		const previousGeneration = await graph.getGeneration();
		// A remote-tracked workspace whose origin has moved past the last recorded commit is
		// refetched in place, and any already-warm index evicted, BEFORE ensureWorkspaceIndex
		// below -- an already-warm LSP process built its own project state from the old
		// directory and does not survive having it swapped out from under it, and "before"
		// further down must see the freshly-fetched content, not what was on disk previously.
		await refreshRemoteWorkspaceIfMoved(input.workspaceId, entry, previousGeneration);
		const workspaceIndex = warmIndexes.ensureWorkspaceIndex(input.workspaceId);
		if (!supportsCodeIntelligence(workspaceIndex.index)) throw new CodeIntelligenceUnavailable(input.workspaceId);
		const extensions = warmIndexes.sourceExtensions(workspaceIndex.descriptors);
		const before = await deriveSourceManifest(rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);

		// Delta selection: a file whose content hash matches the previous generation's needs no
		// LSP round trip at all. A changed or deleted file's own declarations may have shifted
		// position, so any OTHER file with a direct edge into them must be re-walked too, or its
		// own outgoing edge is silently lost when the changed file's stale nodes are purged (see
		// findDependentFiles). Computed BEFORE any purge, against the graph as it still stands.
		const currentFileSet = new Set(before.absoluteFiles);
		const deletedFiles = (previousGeneration?.walkedFiles ?? []).filter((path) => !currentFileSet.has(path));
		const { changed, unchanged } = diffFileHashes(before.absoluteFiles, before.fileHashes, previousGeneration?.fileContentHashes);

		let filesToReprocess: readonly string[] = before.absoluteFiles;
		let filesToSkip: readonly string[] = [];
		if (unchanged.length > 0) {
			if (changed.length === 0 && deletedFiles.length === 0) {
				filesToReprocess = [];
				filesToSkip = unchanged;
			} else {
				const invalidated = new Set([...changed, ...deletedFiles]);
				const [nodes, edges] = await Promise.all([
					graph.allNodes(MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP + 1),
					graph.allEdges(MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP + 1),
				]);
				const withinLookupBound = nodes.length <= MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP && edges.length <= MAX_GRAPH_SIZE_FOR_DEPENDENT_LOOKUP;
				if (withinLookupBound) {
					const dependents = findDependentFiles(nodes, edges, invalidated);
					const reprocessSet = new Set([...changed, ...dependents]);
					filesToReprocess = [...reprocessSet];
					filesToSkip = unchanged.filter((file) => !reprocessSet.has(file));
				}
			}
		}

		await purgeFilesNoLongerWalked(graph, previousGeneration?.walkedFiles, before.absoluteFiles);
		// Only genuinely-changed files' own nodes are purged -- their positions may have shifted.
		// A dependent file's own declarations haven't moved, so purging it would also cascade-delete
		// a THIRD file's still-valid edge into it for no reason; reprocessing alone (idempotent
		// addNode/addEdge) already refreshes its outgoing edges correctly.
		for (const file of changed) await graph.removeNodesForFile(file);

		const reprocessResult = await populateSymbolGraphQuery(
			workspaceIndex.index,
			graph,
			filesToReprocess,
			input.maxSymbolsPerFile,
			logger,
			POPULATION_CONCURRENCY,
		);
		const after = await deriveSourceManifest(rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES);
		if (after.fingerprint !== before.fingerprint) throw new WorkspaceChangedDuringPopulation(input.workspaceId);

		const result = mergePopulationResult(reprocessResult, filesToSkip.length, before.absoluteFiles.length);
		const fileContentHashes = computeUpdatedFileContentHashes(
			previousGeneration?.fileContentHashes,
			filesToSkip,
			filesToReprocess,
			before.fileHashes,
			reprocessResult.failures,
			reprocessResult.failuresTruncated,
		);

		await graph.setGeneration({
			sourceFingerprint: after.fingerprint,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
			completedAt: Date.now(),
			provenance: workspaceIndex.index.provenance,
			sources: workspaceIndex.sources,
			result,
			gitHeadSha: await captureGitHeadShaIfClean(rootPath),
			walkedFiles: before.absoluteFiles,
			fileContentHashes,
			remoteReference: entry.remoteReference,
			remoteCommit: entry.remoteReference ? await repoFetcher?.resolveRemoteCommit(entry.remoteReference) : undefined,
		});
		// A workspace that has been populated at least once stays graph-watched for the rest of
		// the daemon's uptime -- the whole point of "keeps the symbol graph warm on disk changes".
		// Gated on being a real git repository: a raw, non-git directory (workspaceForPath's own
		// intentional fs-root/scratch-file fallback, or any other broad/ambiguous root) must never
		// get an automatic, unbounded OS-level recursive watcher armed against it -- confirmed live
		// as a real resource-exhaustion/runaway-process incident. populateSymbolGraph itself still
		// honors an explicit, one-off request against any workspace; only the *automatic* rearm on
		// every future file change requires git. A remote-origin workspace is always git-backed (it
		// was cloned by GitRepoFetcher) -- skipping the redundant real `git` subprocess check for it
		// avoids adding latency to the exact refetch-then-repopulate window where a freshly-swapped
		// checkout's warm LSP process is most timing-sensitive (a real regression this caused,
		// caught live: an added git subprocess call there destabilized a warm tsserver's project
		// state into "No Project" under load).
		if (entry.origin === "remote" || (await createGitPort(rootPath).isGitRepository())) {
			graphRefresh.markWatched(input.workspaceId);
			ensureOsWatcher(input.workspaceId, rootPath);
		}
		return result;
	}

	async function cacheStatusHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.cacheStatus"],
	): Promise<OperationOutputs["workspace.cacheStatus"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		const activeJobId = graphRefresh.activeJob(input.workspaceId);
		if (activeJobId) {
			const snapshot = jobs.status(activeJobId);
			if (snapshot.status === "queued" || snapshot.status === "running") return { status: "caching", jobId: activeJobId };
			graphRefresh.clearActiveJob(input.workspaceId);
		}
		const graph = ensureSymbolGraph(input.workspaceId);
		const generation = await graph.getGeneration();
		if (!generation) return { status: "not-cached", reason: "no-completed-generation" };
		if (generation.maxFiles !== input.maxFiles || generation.maxSymbolsPerFile !== input.maxSymbolsPerFile) {
			return { status: "not-cached", reason: "bounds-changed" };
		}
		// A remote-tracked workspace whose origin has moved is refetched in place right here, so
		// the full-rehash fallback below (the only check remote workspaces ever reach -- they never
		// carry a gitHeadSha, .git is stripped from a fetched clone) naturally sees the new content
		// and reports source-changed on its own; no separate status reason needed.
		await refreshRemoteWorkspaceIfMoved(input.workspaceId, entry, generation);
		// Fast path: skip the full source rehash below entirely when git alone already proves
		// nothing changed (same clean tree, same HEAD). Inconclusive (no recorded sha, dirty tree,
		// moved HEAD, any git error) always falls through to the authoritative full check --
		// this path can only ever short-circuit to the SAME answer the full check would give,
		// never a different one.
		if (generation.gitHeadSha !== undefined && (await isCacheFreshViaGit(entry.rootPath, generation.gitHeadSha))) {
			return generation.result.completeness === "partial" ? { status: "partial", generation } : { status: "cached", generation };
		}
		const discovered = discoverWorkspaceDescriptors(entry.rootPath, LANGUAGE_SERVER_DESCRIPTORS);
		if (discovered.length === 0) return { status: "not-cached", reason: "source-changed" };
		const extensions = warmIndexes.sourceExtensions(discovered.map(({ descriptor }) => descriptor));
		let currentFingerprint: string;
		try {
			currentFingerprint = (await deriveSourceManifest(entry.rootPath, extensions, input.maxFiles, MAX_SOURCE_MANIFEST_BYTES)).fingerprint;
		} catch {
			return { status: "not-cached", reason: "source-changed" };
		}
		if (currentFingerprint !== generation.sourceFingerprint) return { status: "not-cached", reason: "source-changed" };
		return generation.result.completeness === "partial" ? { status: "partial", generation } : { status: "cached", generation };
	}

	/** Every top-level document symbol's own selectionRange -- deliberately not descending into `children` (a class method can't itself be reached via a module specifier, only the file's own top-level exports can be). */
	function flattenTopLevelPositions(symbols: readonly DocumentSymbolEntry[], path: string): Array<{ path: string; line: number; character: number }> {
		return symbols.map((symbol) => ({ path, line: symbol.selectionRange.start.line, character: symbol.selectionRange.start.character }));
	}

	async function referenceBasedRenameHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.referenceBasedRename"],
	): Promise<OperationOutputs["workspace.referenceBasedRename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);

		// Point 6 of this operation's own design: refuse outright, before touching anything, unless
		// the symbol graph is fully "cached" for these exact bounds -- a "partial" or "not-cached"
		// graph cannot honestly enumerate every reference, and CodeScaleBench's own finding is that a
		// partial multi-file change scores WORSE than no change at all.
		const status = await cacheStatusHandler(registry, { workspaceId: input.workspaceId, maxFiles: input.maxFiles, maxSymbolsPerFile: input.maxSymbolsPerFile });
		if (status.status !== "cached") throw new ReferenceBasedRenameRequiresFreshGraph(input.workspaceId, status.status);

		const fromPath = entry.port.resolvePath(input.fromPath);
		const toPath = entry.port.resolvePath(input.toPath);

		const { index } = await requireCodeIntelligence(warmIndexes, { workspaceId: input.workspaceId, path: fromPath });
		const topLevelSymbols = await documentSymbolsQuery(index, fromPath);
		const positions = flattenTopLevelPositions(topLevelSymbols, fromPath);

		const referencingPaths = new Set<string>();
		for (const position of positions) {
			const locations = await findReferencesQuery(index, { path: position.path, line: position.line, character: position.character }, false);
			for (const location of locations) {
				const locationPath = entry.port.resolvePath(location.path);
				if (locationPath !== fromPath) referencingPaths.add(locationPath);
			}
		}

		const referencingFiles = [];
		for (const path of referencingPaths) {
			const read = await entry.port.readEntry(path);
			if (!read.exists) continue;
			const hash = contentHashOf(read.content);
			const importSpecifiers = await findImportSpecifiers(read.content, extname(path));
			referencingFiles.push({ path, content: read.content, hash, importSpecifiers });
		}

		const movedFile = await entry.port.readEntry(fromPath);
		if (!movedFile.exists) throw new WorkspaceEntryNotFound(fromPath);

		const plan = planReferenceBasedRename({
			fromPath,
			toPath,
			movedFileContent: movedFile.content,
			movedFileHash: contentHashOf(movedFile.content),
			referencingFiles,
		});

		return applyReferenceBasedRename(entry.port, plan);
	}

	async function prepareRenameHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.prepareRename"],
	): Promise<OperationOutputs["workspace.prepareRename"]> {
		const { index } = await requireCodeIntelligence(warmIndexes, input);
		if (!index.prepareRename) throw new RenameNotSupported(input.workspaceId);
		const range = await index.prepareRename({ path: input.path, line: input.line, character: input.character });
		return { range, provenance: index.provenance };
	}

	async function renameHandler(_registry: MutableRegistry, input: OperationInputs["workspace.rename"]): Promise<OperationOutputs["workspace.rename"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		const { index } = await requireCodeIntelligence(warmIndexes, input);
		if (!index.rename) throw new RenameNotSupported(input.workspaceId);
		const rename = index.rename.bind(index);

		return renameMutationBarrier.run(input.workspaceId, async () => {
			const edit: ParsedWorkspaceEdit = await rename({ path: input.path, line: input.line, character: input.character }, input.newName);
			const renamePairs = edit.operations.filter((op) => op.kind === "rename").map((op) => ({ fromPath: op.fromPath, toPath: op.toPath }));
			const createPaths = edit.operations.filter((op) => op.kind === "create").map((op) => op.path);
			const deletePaths = edit.operations.filter((op) => op.kind === "delete").map((op) => op.path);

			// The caller's own snapshot of every touched path's current hash -- taken immediately
			// before applying, as close as Lector can get to "what the server actually saw" without
			// re-running its own analysis. applyWorkspaceEdit validates every step against this,
			// never a fresh read taken mid-apply (see its own doc comment for why that would catch
			// nothing).
			const expectedHashes = new Map<string, ContentHash | null>();
			for (const path of collectTouchedPaths(edit)) {
				const read = await entry.port.readEntry(path);
				expectedHashes.set(path, read.exists ? contentHashOf(read.content) : null);
			}

			await index.notifyFilesWillRename?.(renamePairs);
			await index.notifyFilesWillCreate?.(createPaths);
			await index.notifyFilesWillDelete?.(deletePaths);
			const outcome = await applyWorkspaceEdit(entry.port, edit, expectedHashes);
			index.notifyFilesDidRename?.(renamePairs);
			index.notifyFilesDidCreate?.(createPaths);
			index.notifyFilesDidDelete?.(deletePaths);

			return { touchedPaths: outcome.touchedPaths, provenance: index.provenance };
		});
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	async function scheduleGraphRefresh(workspaceId: WorkspaceId): Promise<void> {
		const workspace = registry.get(workspaceId);
		if (!workspace) return; // workspace no longer known -- nothing to refresh
		const existingJobId = graphRefresh.activeJob(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				graphRefresh.schedule(workspaceId, () => {
					void scheduleGraphRefresh(workspaceId);
				});
				return;
			}
			graphRefresh.clearActiveJob(workspaceId);
		}
		const generation = await graphRefresh.graph(workspaceId).getGeneration();
		if (!generation) return; // never populated (or its cache was reset) -- nothing to keep warm
		const input = { workspaceId, maxFiles: generation.maxFiles, maxSymbolsPerFile: generation.maxSymbolsPerFile };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation: "workspace.populateSymbolGraph",
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraphHandler(registry, input);
				} finally {
					graphRefresh.clearActiveJob(workspaceId, submittedJobId);
				}
			},
		});
		submittedJobId = submitted.id;
		graphRefresh.setActiveJob(workspaceId, submitted.id);
	}

	async function submitJobHandler(_registry: MutableRegistry, request: OperationInputs["job.submit"]): Promise<OperationOutputs["job.submit"]> {
		const rawRequest: unknown = request;
		if (!isRecord(rawRequest)) throw new InvalidJobInput("request must be an object");
		const operation = rawRequest.operation;
		if (operation !== "workspace.populateSymbolGraph") throw new UnsupportedJobOperation(String(operation));
		const rawInput = rawRequest.input;
		if (!isRecord(rawInput)) throw new InvalidJobInput("input must be an object");
		const { workspaceId, maxFiles, maxSymbolsPerFile } = rawInput;
		if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new InvalidJobInput("workspaceId must be a non-empty string");
		if (typeof maxFiles !== "number" || !Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new InvalidJobInput("maxFiles must be a positive safe integer");
		if (typeof maxSymbolsPerFile !== "number" || !Number.isSafeInteger(maxSymbolsPerFile) || maxSymbolsPerFile < 1) {
			throw new InvalidJobInput("maxSymbolsPerFile must be a positive safe integer");
		}
		const rawWaitMs = rawRequest.waitMs;
		const waitMs = rawWaitMs ?? 0;
		if (typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 0) throw new InvalidJobInput("waitMs must be a non-negative safe integer");
		if (waitMs > MAX_INITIAL_JOB_WAIT_MS) throw new JobWaitTooLong(waitMs, MAX_INITIAL_JOB_WAIT_MS);
		const workspace = registry.get(workspaceId);
		if (!workspace) throw new UnknownWorkspace(workspaceId);
		const existingJobId = graphRefresh.activeJob(workspaceId);
		if (existingJobId) {
			const existing = jobs.status(existingJobId);
			if (existing.status === "queued" || existing.status === "running") {
				return { job: waitMs === 0 ? existing : await jobs.wait(existing.id, waitMs) };
			}
			graphRefresh.clearActiveJob(workspaceId);
		}
		const input = { workspaceId, maxFiles, maxSymbolsPerFile };
		let submittedJobId = "";
		const submitted = jobs.submit({
			operation,
			priority: workspace.origin,
			run: async () => {
				try {
					return await populateSymbolGraphHandler(registry, input);
				} finally {
					graphRefresh.clearActiveJob(workspaceId, submittedJobId);
				}
			},
		});
		submittedJobId = submitted.id;
		graphRefresh.setActiveJob(workspaceId, submitted.id);
		jobs.onTerminal(submitted.id, (job) => {
			try {
				publish(jobTopicFor(job.id), { job });
			} catch {
				logger.warn("background job terminal event publish failed", { component: "background-jobs", jobId: job.id });
			}
		});
		return { job: waitMs === 0 ? submitted : await jobs.wait(submitted.id, waitMs) };
	}

	function validatedJobId(input: unknown): string {
		if (!isRecord(input) || typeof input.jobId !== "string" || input.jobId.length === 0) throw new InvalidJobInput("jobId must be a non-empty string");
		return input.jobId;
	}

	function jobStatusHandler(_registry: MutableRegistry, input: OperationInputs["job.status"]): Promise<OperationOutputs["job.status"]> {
		const jobId = validatedJobId(input);
		return Promise.resolve({ job: jobs.status(jobId) });
	}

	function jobWatchHandler(_registry: MutableRegistry, input: OperationInputs["job.watch"]): Promise<OperationOutputs["job.watch"]> {
		const jobId = validatedJobId(input);
		jobs.status(jobId);
		return Promise.resolve({ watchId: jobWatchIdFor(jobId), topic: jobTopicFor(jobId) });
	}

	async function reachableFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.reachableFrom"],
	): Promise<OperationOutputs["workspace.reachableFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await reachableSymbolsFrom(graph, id, { maxDepth: input.maxDepth, kind: input.kind });
		return { symbols };
	}

	async function symbolEdgesFromHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesFrom"],
	): Promise<OperationOutputs["workspace.symbolEdgesFrom"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesFrom(graph, id, input.kind);
		return { symbols };
	}

	async function symbolEdgesToHandler(
		_registry: MutableRegistry,
		input: OperationInputs["workspace.symbolEdgesTo"],
	): Promise<OperationOutputs["workspace.symbolEdgesTo"]> {
		const graph = ensureSymbolGraph(input.workspaceId);
		const id = deriveSymbolNodeId({ path: input.path, line: input.line, character: input.character });
		const symbols = await symbolEdgesTo(graph, id, input.kind);
		return { symbols };
	}

	return {
		handlers: {
			"workspace.populateSymbolGraph": populateSymbolGraphHandler,
			"workspace.cacheStatus": cacheStatusHandler,
			"workspace.referenceBasedRename": referenceBasedRenameHandler,
			"workspace.prepareRename": prepareRenameHandler,
			"workspace.rename": renameHandler,
			"workspace.reachableFrom": reachableFromHandler,
			"workspace.symbolEdgesFrom": symbolEdgesFromHandler,
			"workspace.symbolEdgesTo": symbolEdgesToHandler,
			"job.submit": submitJobHandler,
			"job.status": jobStatusHandler,
			"job.watch": jobWatchHandler,
		},
		scheduleGraphRefresh,
	};
}
