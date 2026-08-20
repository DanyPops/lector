import {
	BoundedResourcePool,
	ResourceAdmissionQueueFull as PoolAdmissionQueueFull,
	ResourceAdmissionQueueTimedOut as PoolAdmissionQueueTimedOut,
	ResourceCapacityExceeded as PoolCapacityExceeded,
	type PooledResource,
	type PoolLease,
	ResourceInUse as PoolResourceInUse,
} from "@danypops/vehicle-core";
import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { LanguageServerDescriptor } from "../code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceDescriptor, discoverWorkspaceDescriptors } from "../code-intelligence/lsp/discover-seed-file.ts";
import { PolyglotCodeIntelligenceIndex, type PolyglotIndexEntry } from "../code-intelligence/polyglot-code-intelligence-index.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import type { WarmIndexResourcePolicy, WarmIndexResourceStatus } from "../code-intelligence/warm-index-resource-policy.ts";
import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";
import { WarmIndexAdmissionQueueFull, WarmIndexAdmissionQueueTimedOut, WarmIndexCapacityExceeded, WarmIndexInUse } from "./errors.ts";

// Re-exported for import-path stability -- these 4 errors moved to errors.ts (the established
// home for every other service-layer error), but every existing call site importing them from
// this module keeps working unchanged.
export { WarmIndexAdmissionQueueFull, WarmIndexAdmissionQueueTimedOut, WarmIndexCapacityExceeded, WarmIndexInUse };

/** A SymbolIndexPort the registry can shut down when its workspace goes cold. processId, when present, names the real subprocess process-cost calibration may sample -- undefined for backends with no subprocess of their own (tree-sitter, the TypeScript compiler API). */
export type ClosableSymbolIndex = SymbolIndexPort & { close(): Promise<void>; isAlive?(): boolean; readonly processId?: number };

/** The registry's own dependency-inversion seam onto calibration -- narrow and mockable, never a direct concrete-class dependency on LanguageServerCostCalibrator. */
export interface WarmIndexProcessCostRecorder {
	recordSample(languageId: string, pid: number): void;
}

export function supportsCodeIntelligence(index: SymbolIndexPort): index is SymbolIndexPort & CodeIntelligencePort {
	return "goToDefinition" in index && typeof index.goToDefinition === "function";
}

const DEFAULT_LANGUAGE_LIMITS: Readonly<Record<string, number>> = Object.freeze({ c: 1, cpp: 1, typescript: 2 });

/**
 * Distinguishes an interactive human/agent-facing request (findSymbols, goToDefinition, rename,
 * cross-project search) from a self-scheduled background one (populateSymbolGraph). Foreground
 * admission is never queued or reduced below reservedForegroundSlots' effective ceiling --
 * background is the only work kind that ever waits. Defaults to "foreground": every existing
 * caller that never opts in keeps today's exact behavior.
 */
export type WarmIndexWorkKind = "foreground" | "background";

export type WarmIndexPoolEvent =
	| { readonly kind: "admission-evicted" | "dead-replaced" | "resource-pressure-evicted"; readonly languageId: string }
	| {
			readonly kind: "close-failed";
			readonly reason: "admission" | "dead-replacement" | "idle-reap" | "resource-pressure";
			readonly languageId: string;
			readonly errorName: string;
	  };

export interface WarmIndexRegistryOptions<WorkspaceKey extends string> {
	readonly descriptors: readonly LanguageServerDescriptor[];
	readonly resolveRoot: (workspaceId: WorkspaceKey) => string;
	readonly createIndex: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
	readonly unsupportedLanguage?: (path: string) => Error;
	readonly now?: () => number;
	readonly maxActive?: number;
	readonly languageLimits?: Readonly<Record<string, number>>;
	readonly resourcePolicy?: WarmIndexResourcePolicy;
	/** The hard structural ceiling a resource policy's own softActiveCeiling can never raise maxActive past. Defaults to 32. Must be >= maxActive. */
	readonly absoluteMaxActiveIndexes?: number;
	readonly observe?: (event: WarmIndexPoolEvent) => void;
	/** Slots background admission alone can never grow into -- "borrowable" because it only constrains background's own effective ceiling, never reserves capacity foreground can't already reach; background simply queues instead of admitting past it. Default 0 (today's exact behavior: no reservation). */
	readonly reservedForegroundSlots?: number;
	/** How long a queued background admission waits for a slot before giving up with WarmIndexAdmissionQueueTimedOut. Default 10s. */
	readonly backgroundAdmissionQueueTimeoutMs?: number;
	/** How many background admissions may be simultaneously waiting before a new one fails fast with WarmIndexAdmissionQueueFull instead of growing the wait queue further. Default 8. */
	readonly maxQueuedBackgroundAdmissions?: number;
	/** Fed one real (languageId, pid) pair per active entry on calibrateProcessCosts() -- optional, since a caller without a resource policy has nothing for calibration to improve. */
	readonly processCostCalibrator?: WarmIndexProcessCostRecorder;
	/** Strategy for combining several per-language indexes into the single SymbolIndexPort a multi-language workspace lease returns. Defaults to PolyglotCodeIntelligenceIndex -- injected so a caller can test or extend composition without pulling in that concrete class. */
	readonly composeIndexes?: (indexes: readonly PolyglotIndexEntry[]) => SymbolIndexPort;
}

/** Which ceiling actually constrained the most recent admission decision -- "configured" when no resource policy is present or it reported no room to raise, "resource-budget" when the policy's own soft ceiling (derived from the real memory budget) is currently in effect above maxActive, "absolute-cap" when a resource policy would allow more but DEFAULT_ABSOLUTE_MAX_ACTIVE/absoluteMaxActiveIndexes itself is the binding constraint. */
export type WarmIndexActiveCeilingSource = "configured" | "resource-budget" | "absolute-cap";

export interface WarmIndexPoolStatus {
	readonly active: number;
	readonly leased: number;
	readonly maxActive: number;
	/** The count ceiling actually in effect for the most recent admission -- may exceed maxActive when a resource policy's own soft ceiling raised it, never exceeds absoluteMaxActiveIndexes. */
	readonly effectiveMaxActive: number;
	readonly activeCeilingSource: WarmIndexActiveCeilingSource;
	readonly absoluteMaxActiveIndexes: number;
	readonly byLanguage: Readonly<Record<string, number>>;
	readonly resources?: WarmIndexResourceStatus;
	/** How many background admissions are currently waiting for a slot reserved for foreground work -- path-free, language/count only. Zero whenever reservedForegroundSlots is unset or nothing is contending. */
	readonly waitingBackgroundAdmissions: number;
}

export interface WarmIndexLease<Value> extends AsyncDisposable {
	readonly value: Value;
}

interface WorkspaceIndex {
	readonly index: SymbolIndexPort;
	readonly descriptors: readonly LanguageServerDescriptor[];
	readonly sources: readonly IntelligenceProvenance[];
}

/** The pool's own generic resource shape, wrapping a real ClosableSymbolIndex -- costHandle carries processId through to calibrateCosts() without requiring ClosableSymbolIndex itself to know about the pool's own vocabulary. */
interface PooledSymbolIndex extends PooledResource {
	readonly index: ClosableSymbolIndex;
}

function wrapForPool(index: ClosableSymbolIndex): PooledSymbolIndex {
	return {
		index,
		close: () => index.close(),
		isAlive: index.isAlive ? () => index.isAlive?.() ?? false : undefined,
		costHandle: index.processId,
	};
}

/** Translates the generic pool's own error vocabulary back to WarmIndexRegistry's long-established names -- every existing caller/test keeps matching on WarmIndex* by name and instanceof. */
function translateAdmissionError(error: unknown, languageId: string): never {
	if (error instanceof PoolCapacityExceeded) throw new WarmIndexCapacityExceeded(languageId, error.maxActive, error.partitionLimit);
	if (error instanceof PoolAdmissionQueueFull) throw new WarmIndexAdmissionQueueFull(languageId, error.maxQueued);
	if (error instanceof PoolAdmissionQueueTimedOut) throw new WarmIndexAdmissionQueueTimedOut(languageId, error.timeoutMs);
	throw error;
}

/** Owns the bounded lifecycle of warm per-workspace, per-language symbol indexes -- a thin, LSP-specific wrapper around vehicle-core's own BoundedResourcePool, which owns every admission/eviction/leasing mechanic generically. */
export class WarmIndexRegistry<WorkspaceKey extends string> {
	private readonly pool: BoundedResourcePool<WorkspaceKey, PooledSymbolIndex, WarmIndexResourceStatus>;

	constructor(private readonly options: WarmIndexRegistryOptions<WorkspaceKey>) {
		this.pool = new BoundedResourcePool<WorkspaceKey, PooledSymbolIndex, WarmIndexResourceStatus>({
			maxActive: options.maxActive,
			partitionLimits: options.languageLimits ?? DEFAULT_LANGUAGE_LIMITS,
			resourcePolicy: options.resourcePolicy,
			absoluteMaxActive: options.absoluteMaxActiveIndexes,
			reservedForegroundSlots: options.reservedForegroundSlots,
			backgroundAdmissionQueueTimeoutMs: options.backgroundAdmissionQueueTimeoutMs,
			maxQueuedBackgroundAdmissions: options.maxQueuedBackgroundAdmissions,
			now: options.now,
			costRecorder: options.processCostCalibrator
				? {
						recordSample: (languageId, costHandle) => {
							if (typeof costHandle === "number") options.processCostCalibrator?.recordSample(languageId, costHandle);
						},
					}
				: undefined,
			observe: options.observe
				? (event) =>
						options.observe?.(
							event.kind === "close-failed"
								? { kind: "close-failed", reason: event.reason, languageId: event.partitionKey, errorName: event.errorName }
								: { kind: event.kind, languageId: event.partitionKey },
						)
				: undefined,
		});
	}

	private descriptorForPath(path: string): LanguageServerDescriptor | undefined {
		const extensionStart = path.lastIndexOf(".");
		if (extensionStart === -1) return undefined;
		const extension = path.slice(extensionStart);
		return this.options.descriptors.find((descriptor) => descriptor.extensions.includes(extension));
	}

	private unsupportedLanguage(path: string): Error {
		return this.options.unsupportedLanguage?.(path) ?? new Error(`unsupported language: ${path}`);
	}

	/** True while at least one background admission for this workspace is currently waiting for a reserved-slot conflict to clear -- workspace.cacheStatus's "waiting-for-resources" signal. */
	waitingForAdmission(workspaceId: WorkspaceKey): boolean {
		return this.pool.waitingForAdmission(workspaceId);
	}

	private async acquireLanguageLease(
		workspaceId: WorkspaceKey,
		rootPath: string,
		descriptor: LanguageServerDescriptor,
		seedFile: string | undefined,
		workKind: WarmIndexWorkKind,
	): Promise<PoolLease<PooledSymbolIndex>> {
		try {
			return await this.pool.acquire(workspaceId, descriptor.languageId, () => wrapForPool(this.options.createIndex(rootPath, descriptor, seedFile)), workKind);
		} catch (error) {
			translateAdmissionError(error, descriptor.languageId);
		}
	}

	private combineLeases<Value>(value: Value, poolLeases: readonly PoolLease<PooledSymbolIndex>[]): WarmIndexLease<Value> {
		let released = false;
		return {
			value,
			[Symbol.asyncDispose]: async () => {
				if (released) return;
				released = true;
				await Promise.all(poolLeases.map((lease) => lease[Symbol.asyncDispose]()));
			},
		};
	}

	async leaseWarmIndex(input: {
		readonly workspaceId: WorkspaceKey;
		readonly path?: string;
		readonly seedFile?: string;
		readonly workKind?: WarmIndexWorkKind;
	}): Promise<
		WarmIndexLease<{
			index: ClosableSymbolIndex;
			descriptor: LanguageServerDescriptor;
		}>
	> {
		const rootPath = this.options.resolveRoot(input.workspaceId);
		const pathHint = input.path ?? input.seedFile;
		let descriptor: LanguageServerDescriptor;
		let seedFile = input.seedFile;
		if (pathHint) {
			const matched = this.descriptorForPath(pathHint);
			if (!matched) throw this.unsupportedLanguage(pathHint);
			descriptor = matched;
		} else {
			const discovered = discoverWorkspaceDescriptor(rootPath, this.options.descriptors);
			if (!discovered) throw this.unsupportedLanguage(rootPath);
			descriptor = discovered.descriptor;
			seedFile = discovered.seedFile;
		}
		const poolLease = await this.acquireLanguageLease(input.workspaceId, rootPath, descriptor, seedFile, input.workKind ?? "foreground");
		return this.combineLeases({ index: poolLease.value.index, descriptor }, [poolLease]);
	}

	async leaseWorkspaceIndex(
		workspaceId: WorkspaceKey,
		preferredSeedFile?: string,
		workKind: WarmIndexWorkKind = "foreground",
	): Promise<WarmIndexLease<WorkspaceIndex>> {
		const rootPath = this.options.resolveRoot(workspaceId);
		const preferredDescriptor = preferredSeedFile ? this.descriptorForPath(preferredSeedFile) : undefined;
		if (preferredSeedFile && !preferredDescriptor) throw this.unsupportedLanguage(preferredSeedFile);
		const discovered = [...discoverWorkspaceDescriptors(rootPath, this.options.descriptors)];
		if (preferredDescriptor && preferredSeedFile && !discovered.some(({ descriptor }) => descriptor.languageId === preferredDescriptor.languageId)) {
			discovered.push({ descriptor: preferredDescriptor, seedFile: preferredSeedFile });
		}
		if (discovered.length === 0) throw this.unsupportedLanguage(rootPath);
		const poolLeases: PoolLease<PooledSymbolIndex>[] = [];
		try {
			for (const { descriptor, seedFile } of discovered) {
				poolLeases.push(
					await this.acquireLanguageLease(
						workspaceId,
						rootPath,
						descriptor,
						preferredDescriptor?.languageId === descriptor.languageId ? preferredSeedFile : seedFile,
						workKind,
					),
				);
			}
		} catch (error) {
			await this.combineLeases(undefined, poolLeases)[Symbol.asyncDispose]();
			throw error;
		}
		const indexes = poolLeases.map((poolLease, index) => {
			const source = discovered[index];
			if (!source) throw new Error("warm-index lease lost its language descriptor");
			return { descriptor: source.descriptor, index: poolLease.value.index };
		});
		const first = indexes[0];
		const composeIndexes = this.options.composeIndexes ?? ((entries: readonly PolyglotIndexEntry[]) => new PolyglotCodeIntelligenceIndex(entries));
		const index: SymbolIndexPort = indexes.length === 1 && first ? first.index : composeIndexes(indexes);
		return this.combineLeases(
			{
				index,
				descriptors: discovered.map(({ descriptor }) => descriptor),
				sources: poolLeases.map((poolLease) => poolLease.value.index.provenance),
			},
			poolLeases,
		);
	}

	sourceExtensions(descriptors: readonly LanguageServerDescriptor[]): readonly string[] {
		return Array.from(new Set(descriptors.flatMap((descriptor) => descriptor.extensions)));
	}

	hasWarmIndex(workspaceId: WorkspaceKey, path?: string): boolean {
		if (path) {
			const descriptor = this.descriptorForPath(path);
			return descriptor ? this.pool.has(workspaceId, descriptor.languageId) : false;
		}
		return this.pool.hasAny(workspaceId);
	}

	status(): WarmIndexPoolStatus {
		const poolStatus = this.pool.status();
		return {
			active: poolStatus.active,
			leased: poolStatus.leased,
			maxActive: poolStatus.maxActive,
			effectiveMaxActive: poolStatus.effectiveMaxActive,
			activeCeilingSource: poolStatus.activeCeilingSource,
			absoluteMaxActiveIndexes: poolStatus.absoluteMaxActive,
			byLanguage: poolStatus.byPartition,
			waitingBackgroundAdmissions: poolStatus.waitingBackgroundAdmissions,
			...(poolStatus.resources !== undefined ? { resources: poolStatus.resources } : {}),
		};
	}

	/**
	 * Samples every currently active entry's own real process tree and folds it into the
	 * configured calibrator, if any -- a no-op without one.
	 */
	calibrateProcessCosts(): void {
		this.pool.calibrateCosts();
	}

	private codeIntelligenceIndexes(workspaceId: WorkspaceKey): Array<ClosableSymbolIndex & CodeIntelligencePort> {
		const indexes: Array<ClosableSymbolIndex & CodeIntelligencePort> = [];
		for (const resource of this.pool.activeResourcesForOwner(workspaceId)) {
			if (supportsCodeIntelligence(resource.index)) indexes.push(resource.index);
		}
		return indexes;
	}

	notifyFileChanged(workspaceId: WorkspaceKey, event: FileChangeEvent): void {
		for (const index of this.codeIntelligenceIndexes(workspaceId)) index.notifyFileChanged?.(event);
	}

	async notifyFilesWillCreate(workspaceId: WorkspaceKey, paths: readonly string[]): Promise<void> {
		await Promise.all(this.codeIntelligenceIndexes(workspaceId).map((index) => index.notifyFilesWillCreate?.(paths) ?? Promise.resolve()));
	}

	notifyFilesDidCreate(workspaceId: WorkspaceKey, paths: readonly string[]): void {
		for (const index of this.codeIntelligenceIndexes(workspaceId)) index.notifyFilesDidCreate?.(paths);
	}

	async notifyFilesWillDelete(workspaceId: WorkspaceKey, paths: readonly string[]): Promise<void> {
		await Promise.all(this.codeIntelligenceIndexes(workspaceId).map((index) => index.notifyFilesWillDelete?.(paths) ?? Promise.resolve()));
	}

	notifyFilesDidDelete(workspaceId: WorkspaceKey, paths: readonly string[]): void {
		for (const index of this.codeIntelligenceIndexes(workspaceId)) index.notifyFilesDidDelete?.(paths);
	}

	async closeWorkspace(workspaceId: WorkspaceKey): Promise<void> {
		await this.pool.closeOwner(workspaceId);
	}

	/**
	 * Force-closes only the one warm index (if any) whose own descriptor names `changedPath`'s
	 * basename as a rootMarker -- Cargo.toml for Rust, go.mod/go.work for Go, tsconfig.json/
	 * jsconfig.json/package.json for TypeScript, and so on for any future descriptor. A real
	 * project-manifest change can restructure a workspace's own crate/module/project graph in a
	 * way a live workspace/didChangeWatchedFiles notification does not reliably make the server
	 * pick up (confirmed live: rust-analyzer keeps serving its pre-change crate graph after
	 * adding a `[lib]` target to a Cargo.toml that previously had none, even after the
	 * notification is correctly delivered and its own background work goes idle again -- a fresh
	 * process against the same directory sees the new target immediately). Never touches a warm
	 * index for a different language sharing this same polyglot workspace -- a Cargo.toml change
	 * has no bearing on an already-warm TypeScript index here. Unconditional, like closeWorkspace
	 * above and for the same reason: a process serving a stale, structurally wrong project graph
	 * is strictly worse than the cost of a fresh respawn, lease or not. closePartition is already
	 * a safe no-op for a language with nothing warm, so every matching descriptor's languageId is
	 * tried regardless of whether it's actually active for this workspace right now.
	 */
	async closeForRootMarkerChange(workspaceId: WorkspaceKey, changedPath: string): Promise<void> {
		const basename = changedPath.split("/").pop() ?? changedPath;
		const matchingLanguageIds = this.options.descriptors
			.filter((descriptor) => descriptor.rootMarkers.includes(basename))
			.map((descriptor) => descriptor.languageId);
		await Promise.all(matchingLanguageIds.map((languageId) => this.pool.closePartition(workspaceId, languageId)));
	}

	/**
	 * The safe sibling of closeWorkspace: refuses (does not evict anything) while any of this
	 * workspace's warm indexes has an active lease, instead of closeWorkspace's own unconditional
	 * force-close (which exists for the very different case of a remote directory swapped out
	 * from under an already-warm process -- correctness there requires closing regardless of who
	 * still holds it).
	 */
	async releaseWorkspaceIfIdle(workspaceId: WorkspaceKey): Promise<{ readonly closed: number }> {
		try {
			return await this.pool.releaseOwnerIfIdle(workspaceId);
		} catch (error) {
			if (error instanceof PoolResourceInUse) throw new WarmIndexInUse(workspaceId);
			throw error;
		}
	}

	async closeAll(): Promise<void> {
		await this.pool.closeAll();
	}

	async reconcileResources(): Promise<number> {
		return this.pool.reconcileResources();
	}

	async reapIdle(maxIdleMs: number): Promise<number> {
		return this.pool.reapIdle(maxIdleMs);
	}
}
