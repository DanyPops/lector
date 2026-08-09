import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { LanguageServerDescriptor } from "../code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceDescriptor, discoverWorkspaceDescriptors } from "../code-intelligence/lsp/discover-seed-file.ts";
import { PolyglotCodeIntelligenceIndex } from "../code-intelligence/polyglot-code-intelligence-index.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import type { WarmIndexResourcePolicy, WarmIndexResourceStatus } from "../code-intelligence/warm-index-resource-policy.ts";
import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";

/** A SymbolIndexPort the registry can shut down when its workspace goes cold. processId, when present, names the real subprocess process-cost calibration may sample -- undefined for backends with no subprocess of their own (tree-sitter, the TypeScript compiler API). */
export type ClosableSymbolIndex = SymbolIndexPort & { close(): Promise<void>; isAlive?(): boolean; readonly processId?: number };

/** The registry's own dependency-inversion seam onto calibration -- narrow and mockable, never a direct concrete-class dependency on LanguageServerCostCalibrator. */
export interface WarmIndexProcessCostRecorder {
	recordSample(languageId: string, pid: number): void;
}

export function supportsCodeIntelligence(index: SymbolIndexPort): index is SymbolIndexPort & CodeIntelligencePort {
	return "goToDefinition" in index && typeof index.goToDefinition === "function";
}

const DEFAULT_MAX_ACTIVE = 3;
const DEFAULT_LANGUAGE_LIMITS: Readonly<Record<string, number>> = Object.freeze({ c: 1, cpp: 1, typescript: 2 });

export class WarmIndexCapacityExceeded extends Error {
	constructor(
		readonly languageId: string,
		readonly maxActive: number,
		readonly languageLimit: number,
	) {
		super(
			`no idle code-intelligence server can be evicted to admit "${languageId}" within global capacity ${maxActive} and language capacity ${languageLimit}`,
		);
		this.name = "WarmIndexCapacityExceeded";
	}
}

/** Raised by releaseWorkspaceIfIdle when a warm index for this workspace still has an active lease -- the caller must let the in-flight query finish and retry, never force-closed out from under it. */
export class WarmIndexInUse extends Error {
	constructor(readonly workspaceId: string) {
		super(`cannot release workspace "${workspaceId}": a warm code-intelligence index for it still has an active lease`);
		this.name = "WarmIndexInUse";
	}
}

/**
 * Distinguishes an interactive human/agent-facing request (findSymbols, goToDefinition, rename,
 * cross-project search) from a self-scheduled background one (populateSymbolGraph). Foreground
 * admission is never queued or reduced below reservedForegroundSlots' effective ceiling --
 * background is the only work kind that ever waits. Defaults to "foreground": every existing
 * caller that never opts in keeps today's exact behavior.
 */
export type WarmIndexWorkKind = "foreground" | "background";

/** Raised when background admission is already waiting at maxQueuedBackgroundAdmissions -- fails fast rather than growing the wait queue without bound. */
export class WarmIndexAdmissionQueueFull extends Error {
	constructor(
		readonly languageId: string,
		readonly maxQueued: number,
	) {
		super(`background admission for language "${languageId}" is already waiting at capacity (${maxQueued} queued); retry later`);
		this.name = "WarmIndexAdmissionQueueFull";
	}
}

/** Raised when background admission waited backgroundAdmissionQueueTimeoutMs for a slot reserved for foreground work and none appeared -- a bounded, cancellable wait, not an indefinite one. */
export class WarmIndexAdmissionQueueTimedOut extends Error {
	constructor(
		readonly languageId: string,
		readonly timeoutMs: number,
	) {
		super(
			`background admission for language "${languageId}" waited ${timeoutMs}ms for a warm-index slot and gave up -- foreground demand is holding every admittable slot`,
		);
		this.name = "WarmIndexAdmissionQueueTimedOut";
	}
}

/**
 * Internal signal only: admit() throws this to tell acquireLanguageIndex "release the serialized
 * lock and wait outside it" -- never surfaced to a caller. Waiting for a background admission's
 * turn can legitimately take seconds; holding admissionTail (the single global admission mutex)
 * for that whole span would block every OTHER admission request, including foreground's, which
 * is exactly the starvation this exists to prevent.
 */
class NeedsBackgroundAdmissionWait extends Error {}

const DEFAULT_BACKGROUND_ADMISSION_QUEUE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUED_BACKGROUND_ADMISSIONS = 8;

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
	readonly observe?: (event: WarmIndexPoolEvent) => void;
	/** Slots background admission alone can never grow into -- "borrowable" because it only constrains background's own effective ceiling, never reserves capacity foreground can't already reach; background simply queues instead of admitting past it. Default 0 (today's exact behavior: no reservation). */
	readonly reservedForegroundSlots?: number;
	/** How long a queued background admission waits for a slot before giving up with WarmIndexAdmissionQueueTimedOut. Default 10s. */
	readonly backgroundAdmissionQueueTimeoutMs?: number;
	/** How many background admissions may be simultaneously waiting before a new one fails fast with WarmIndexAdmissionQueueFull instead of growing the wait queue further. Default 8. */
	readonly maxQueuedBackgroundAdmissions?: number;
	/** Fed one real (languageId, pid) pair per active entry on calibrateProcessCosts() -- optional, since a caller without a resource policy has nothing for calibration to improve. */
	readonly processCostCalibrator?: WarmIndexProcessCostRecorder;
}

interface WarmIndexEntry<WorkspaceKey extends string> {
	readonly index: ClosableSymbolIndex;
	readonly workspaceId: WorkspaceKey;
	readonly languageId: string;
	recencySequence: number;
	activeLeases: number;
	lastUsedAt: number;
}

export interface WarmIndexPoolStatus {
	readonly active: number;
	readonly leased: number;
	readonly maxActive: number;
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

/** Owns the bounded lifecycle of warm per-workspace, per-language symbol indexes. */
export class WarmIndexRegistry<WorkspaceKey extends string> {
	private readonly entries = new Map<string, WarmIndexEntry<WorkspaceKey>>();
	private readonly now: () => number;
	private readonly maxActive: number;
	private readonly languageLimits: Readonly<Record<string, number>>;
	private admissionTail: Promise<void> = Promise.resolve();
	private nextSequence = 0;
	private readonly reservedForegroundSlots: number;
	private readonly backgroundAdmissionQueueTimeoutMs: number;
	private readonly maxQueuedBackgroundAdmissions: number;
	private readonly admissionWaiters = new Set<() => void>();
	private queuedBackgroundAdmissions = 0;
	private readonly waitingCounts = new Map<WorkspaceKey, number>();

	constructor(private readonly options: WarmIndexRegistryOptions<WorkspaceKey>) {
		this.now = options.now ?? Date.now;
		this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
		this.languageLimits = options.languageLimits ?? DEFAULT_LANGUAGE_LIMITS;
		if (!Number.isSafeInteger(this.maxActive) || this.maxActive < 1) throw new TypeError("maxActive must be a positive safe integer");
		for (const [languageId, limit] of Object.entries(this.languageLimits)) {
			if (!languageId || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError("language limits must be positive safe integers keyed by language id");
		}
		this.reservedForegroundSlots = options.reservedForegroundSlots ?? 0;
		if (!Number.isSafeInteger(this.reservedForegroundSlots) || this.reservedForegroundSlots < 0) {
			throw new TypeError("reservedForegroundSlots must be a non-negative safe integer");
		}
		this.backgroundAdmissionQueueTimeoutMs = options.backgroundAdmissionQueueTimeoutMs ?? DEFAULT_BACKGROUND_ADMISSION_QUEUE_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.backgroundAdmissionQueueTimeoutMs) || this.backgroundAdmissionQueueTimeoutMs < 0) {
			throw new TypeError("backgroundAdmissionQueueTimeoutMs must be a non-negative safe integer");
		}
		this.maxQueuedBackgroundAdmissions = options.maxQueuedBackgroundAdmissions ?? DEFAULT_MAX_QUEUED_BACKGROUND_ADMISSIONS;
		if (!Number.isSafeInteger(this.maxQueuedBackgroundAdmissions) || this.maxQueuedBackgroundAdmissions < 1) {
			throw new TypeError("maxQueuedBackgroundAdmissions must be a positive safe integer");
		}
	}

	private key(workspaceId: WorkspaceKey, languageId: string): string {
		return `${workspaceId}:${languageId}`;
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

	private languageLimit(languageId: string): number {
		return this.languageLimits[languageId] ?? this.maxActive;
	}

	private countLanguage(languageId: string): number {
		let count = 0;
		for (const entry of this.entries.values()) if (entry.languageId === languageId) count++;
		return count;
	}

	private activeLanguages(): string[] {
		return Array.from(this.entries.values(), (entry) => entry.languageId);
	}

	private leastRecentlyUsedIdle(languageId?: string): [string, WarmIndexEntry<WorkspaceKey>] | undefined {
		let selected: [string, WarmIndexEntry<WorkspaceKey>] | undefined;
		for (const candidate of this.entries) {
			const entry = candidate[1];
			if (entry.activeLeases > 0 || (languageId !== undefined && entry.languageId !== languageId)) continue;
			const current = selected?.[1];
			if (!current || entry.lastUsedAt < current.lastUsedAt || (entry.lastUsedAt === current.lastUsedAt && entry.recencySequence < current.recencySequence))
				selected = candidate;
		}
		return selected;
	}

	private async evict(
		entry: [string, WarmIndexEntry<WorkspaceKey>],
		reason: "admission" | "dead-replacement" | "resource-pressure" = "admission",
	): Promise<void> {
		try {
			await entry[1].index.close();
		} catch (error) {
			this.options.observe?.({
				kind: "close-failed",
				reason,
				languageId: entry[1].languageId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			throw error;
		}
		this.entries.delete(entry[0]);
		const kind = reason === "admission" ? "admission-evicted" : reason === "dead-replacement" ? "dead-replaced" : "resource-pressure-evicted";
		this.options.observe?.({ kind, languageId: entry[1].languageId });
		this.notifyAdmissionWaiters();
	}

	/** Wakes every queued background admission to re-check the real state -- called whenever an entry is removed OR a lease completes (an idle candidate an admit() retry might now be able to evict). A false wake just re-checks and re-waits; never a correctness issue, only a wasted retry. */
	private notifyAdmissionWaiters(): void {
		if (this.admissionWaiters.size === 0) return;
		const waiters = Array.from(this.admissionWaiters);
		this.admissionWaiters.clear();
		for (const waiter of waiters) waiter();
	}

	/** True while at least one background admission for this workspace is currently waiting for a reserved-slot conflict to clear -- workspace.cacheStatus's "waiting-for-resources" signal. */
	waitingForAdmission(workspaceId: WorkspaceKey): boolean {
		return (this.waitingCounts.get(workspaceId) ?? 0) > 0;
	}

	/**
	 * Runs entirely outside the serialized admission lock -- admissionTail is the single global
	 * admission mutex, and this wait can legitimately take up to backgroundAdmissionQueueTimeoutMs.
	 * Holding that lock for the whole wait would block every other admission request, foreground
	 * included, which is the exact starvation this exists to prevent.
	 */
	private async waitForAdmissionRoom(languageId: string, workspaceId: WorkspaceKey): Promise<void> {
		if (this.queuedBackgroundAdmissions >= this.maxQueuedBackgroundAdmissions) {
			throw new WarmIndexAdmissionQueueFull(languageId, this.maxQueuedBackgroundAdmissions);
		}
		this.queuedBackgroundAdmissions++;
		this.waitingCounts.set(workspaceId, (this.waitingCounts.get(workspaceId) ?? 0) + 1);
		try {
			const gotSignal = await new Promise<boolean>((resolve) => {
				let settled = false;
				const finish = (ready: boolean): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.admissionWaiters.delete(onSignal);
					resolve(ready);
				};
				const onSignal = (): void => finish(true);
				const timer = setTimeout(() => finish(false), this.backgroundAdmissionQueueTimeoutMs);
				this.admissionWaiters.add(onSignal);
			});
			if (!gotSignal) throw new WarmIndexAdmissionQueueTimedOut(languageId, this.backgroundAdmissionQueueTimeoutMs);
		} finally {
			this.queuedBackgroundAdmissions--;
			const remaining = (this.waitingCounts.get(workspaceId) ?? 1) - 1;
			if (remaining <= 0) this.waitingCounts.delete(workspaceId);
			else this.waitingCounts.set(workspaceId, remaining);
		}
	}

	private async admit(
		workspaceId: WorkspaceKey,
		rootPath: string,
		descriptor: LanguageServerDescriptor,
		seedFile: string | undefined,
		workKind: WarmIndexWorkKind,
	): Promise<WarmIndexEntry<WorkspaceKey>> {
		const languageLimit = this.languageLimit(descriptor.languageId);
		while (this.countLanguage(descriptor.languageId) >= languageLimit) {
			const victim = this.leastRecentlyUsedIdle(descriptor.languageId);
			if (!victim) throw new WarmIndexCapacityExceeded(descriptor.languageId, this.maxActive, languageLimit);
			await this.evict(victim);
		}
		// "Borrowable": background's own effective ceiling is reduced, but only background is ever
		// held to it -- it constrains what background alone can grow the pool into, not a hard
		// set-aside nothing else can reach. Foreground keeps using the full maxActive unchanged.
		const effectiveMaxActive = workKind === "background" ? Math.max(this.maxActive - this.reservedForegroundSlots, 0) : this.maxActive;
		while (this.entries.size >= effectiveMaxActive) {
			const victim = this.leastRecentlyUsedIdle();
			if (victim) {
				await this.evict(victim);
				continue;
			}
			if (workKind === "background") throw new NeedsBackgroundAdmissionWait();
			throw new WarmIndexCapacityExceeded(descriptor.languageId, this.maxActive, languageLimit);
		}
		while (this.options.resourcePolicy && !this.options.resourcePolicy.canAdmit(this.activeLanguages(), descriptor.languageId)) {
			const victim = this.leastRecentlyUsedIdle();
			if (!victim) throw new WarmIndexCapacityExceeded(descriptor.languageId, this.maxActive, languageLimit);
			await this.evict(victim, "resource-pressure");
		}
		return {
			index: this.options.createIndex(rootPath, descriptor, seedFile),
			workspaceId,
			languageId: descriptor.languageId,
			recencySequence: this.nextSequence++,
			activeLeases: 0,
			lastUsedAt: this.now(),
		};
	}

	private async serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
		const previous = this.admissionTail;
		let release = (): void => {};
		this.admissionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private async acquireLanguageIndex(
		workspaceId: WorkspaceKey,
		rootPath: string,
		descriptor: LanguageServerDescriptor,
		seedFile: string | undefined,
		workKind: WarmIndexWorkKind,
	): Promise<WarmIndexEntry<WorkspaceKey>> {
		for (;;) {
			try {
				return await this.serialized(async () => {
					const key = this.key(workspaceId, descriptor.languageId);
					let entry = this.entries.get(key);
					if (entry?.index.isAlive?.() === false) {
						if (entry.activeLeases > 0) {
							throw new WarmIndexCapacityExceeded(descriptor.languageId, this.maxActive, this.languageLimit(descriptor.languageId));
						}
						await this.evict([key, entry], "dead-replacement");
						entry = undefined;
					}
					if (!entry) {
						entry = await this.admit(workspaceId, rootPath, descriptor, seedFile, workKind);
						this.entries.set(key, entry);
					}
					entry.activeLeases++;
					return entry;
				});
			} catch (error) {
				if (!(error instanceof NeedsBackgroundAdmissionWait)) throw error;
				// Outside the lock deliberately -- see waitForAdmissionRoom's own comment. Throws
				// WarmIndexAdmissionQueueFull/TimedOut instead of looping back if it can't wait.
				await this.waitForAdmissionRoom(descriptor.languageId, workspaceId);
			}
		}
	}

	private lease<Value>(value: Value, entries: readonly WarmIndexEntry<WorkspaceKey>[]): WarmIndexLease<Value> {
		let released = false;
		return {
			value,
			[Symbol.asyncDispose]: async () => {
				if (released) return;
				released = true;
				const completedAt = this.now();
				for (const entry of entries) {
					entry.activeLeases--;
					entry.lastUsedAt = completedAt;
					entry.recencySequence = this.nextSequence++;
				}
				// A lease completing makes its entry newly idle -- exactly the condition a queued
				// background admission's retry is waiting to find, whether or not resource pressure
				// itself ends up evicting anything below.
				this.notifyAdmissionWaiters();
				await this.reconcileResources();
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
		const entry = await this.acquireLanguageIndex(input.workspaceId, rootPath, descriptor, seedFile, input.workKind ?? "foreground");
		return this.lease({ index: entry.index, descriptor }, [entry]);
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
		const entries: WarmIndexEntry<WorkspaceKey>[] = [];
		try {
			for (const { descriptor, seedFile } of discovered) {
				entries.push(
					await this.acquireLanguageIndex(
						workspaceId,
						rootPath,
						descriptor,
						preferredDescriptor?.languageId === descriptor.languageId ? preferredSeedFile : seedFile,
						workKind,
					),
				);
			}
		} catch (error) {
			await this.lease(undefined, entries)[Symbol.asyncDispose]();
			throw error;
		}
		const indexes = entries.map((entry, index) => {
			const source = discovered[index];
			if (!source) throw new Error("warm-index lease lost its language descriptor");
			return { descriptor: source.descriptor, index: entry.index };
		});
		const first = indexes[0];
		const index: SymbolIndexPort = indexes.length === 1 && first ? first.index : new PolyglotCodeIntelligenceIndex(indexes);
		return this.lease(
			{ index, descriptors: discovered.map(({ descriptor }) => descriptor), sources: entries.map(({ index: source }) => source.provenance) },
			entries,
		);
	}

	sourceExtensions(descriptors: readonly LanguageServerDescriptor[]): readonly string[] {
		return Array.from(new Set(descriptors.flatMap((descriptor) => descriptor.extensions)));
	}

	hasWarmIndex(workspaceId: WorkspaceKey, path?: string): boolean {
		if (path) {
			const descriptor = this.descriptorForPath(path);
			return descriptor ? this.entries.has(this.key(workspaceId, descriptor.languageId)) : false;
		}
		for (const entry of this.entries.values()) if (entry.workspaceId === workspaceId) return true;
		return false;
	}

	status(): WarmIndexPoolStatus {
		const byLanguage: Record<string, number> = {};
		let leased = 0;
		for (const entry of this.entries.values()) {
			byLanguage[entry.languageId] = (byLanguage[entry.languageId] ?? 0) + 1;
			if (entry.activeLeases > 0) leased++;
		}
		const resources = this.options.resourcePolicy?.status(this.activeLanguages());
		return {
			active: this.entries.size,
			leased,
			maxActive: this.maxActive,
			byLanguage,
			waitingBackgroundAdmissions: this.queuedBackgroundAdmissions,
			...(resources ? { resources } : {}),
		};
	}

	/**
	 * Samples every currently active entry's own real process tree and folds it into the
	 * configured calibrator, if any -- a no-op without one. Read-only over the entry map (no
	 * admission/eviction decision here), so it deliberately does not run inside serialized(): it
	 * cannot race with admission in any way that matters, and holding the single admission mutex
	 * for N bounded /proc samples would only cost foreground admissions latency for no benefit.
	 */
	calibrateProcessCosts(): void {
		const calibrator = this.options.processCostCalibrator;
		if (!calibrator) return;
		for (const entry of this.entries.values()) {
			const pid = entry.index.processId;
			if (pid === undefined) continue;
			calibrator.recordSample(entry.languageId, pid);
		}
	}

	private codeIntelligenceIndexes(workspaceId: WorkspaceKey): Array<ClosableSymbolIndex & CodeIntelligencePort> {
		const indexes: Array<ClosableSymbolIndex & CodeIntelligencePort> = [];
		for (const entry of this.entries.values()) {
			if (entry.workspaceId === workspaceId && supportsCodeIntelligence(entry.index)) indexes.push(entry.index);
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
		const stale = Array.from(this.entries.entries()).filter(([, entry]) => entry.workspaceId === workspaceId);
		for (const [key] of stale) this.entries.delete(key);
		await Promise.all(stale.map(([, entry]) => entry.index.close()));
	}

	/**
	 * The safe sibling of closeWorkspace: refuses (does not evict anything) while any of this
	 * workspace's warm indexes has an active lease, instead of closeWorkspace's own unconditional
	 * force-close (which exists for the very different case of a remote directory swapped out
	 * from under an already-warm process -- correctness there requires closing regardless of who
	 * still holds it). Serialized against concurrent admission so a lease can't be granted between
	 * the check and the close.
	 */
	async releaseWorkspaceIfIdle(workspaceId: WorkspaceKey): Promise<{ readonly closed: number }> {
		return this.serialized(async () => {
			const matching = Array.from(this.entries.entries()).filter(([, entry]) => entry.workspaceId === workspaceId);
			if (matching.some(([, entry]) => entry.activeLeases > 0)) throw new WarmIndexInUse(workspaceId);
			for (const pair of matching) await this.evict(pair, "admission");
			return { closed: matching.length };
		});
	}

	async closeAll(): Promise<void> {
		const entries = Array.from(this.entries.values());
		this.entries.clear();
		await Promise.all(entries.map((entry) => entry.index.close()));
	}

	private async reconcileResourcesUnsafe(): Promise<number> {
		const policy = this.options.resourcePolicy;
		if (!policy) return 0;
		let reaped = 0;
		while (policy.isOverBudget(this.activeLanguages())) {
			const victim = this.leastRecentlyUsedIdle();
			if (!victim) break;
			try {
				await this.evict(victim, "resource-pressure");
				reaped++;
			} catch {
				break;
			}
		}
		return reaped;
	}

	async reconcileResources(): Promise<number> {
		return this.serialized(() => this.reconcileResourcesUnsafe());
	}

	async reapIdle(maxIdleMs: number): Promise<number> {
		return this.serialized(async () => {
			let reaped = await this.reconcileResourcesUnsafe();
			const now = this.now();
			const effectiveMaxIdleMs = this.options.resourcePolicy?.maxIdleMs(maxIdleMs, this.activeLanguages()) ?? maxIdleMs;
			const idle = Array.from(this.entries.entries()).filter(([, entry]) => entry.activeLeases === 0 && now - entry.lastUsedAt > effectiveMaxIdleMs);
			for (const [key, entry] of idle) {
				try {
					await entry.index.close();
					if (this.entries.get(key) === entry) this.entries.delete(key);
					reaped++;
				} catch (error) {
					this.options.observe?.({
						kind: "close-failed",
						reason: "idle-reap",
						languageId: entry.languageId,
						errorName: error instanceof Error ? error.name : "UnknownError",
					});
				}
			}
			if (idle.length > 0) this.notifyAdmissionWaiters();
			return reaped;
		});
	}
}
