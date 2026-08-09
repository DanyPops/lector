import type { IntelligenceProvenance } from "../code-intelligence/intelligence-provenance.ts";
import type { LanguageServerDescriptor } from "../code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceDescriptor, discoverWorkspaceDescriptors } from "../code-intelligence/lsp/discover-seed-file.ts";
import { PolyglotCodeIntelligenceIndex } from "../code-intelligence/polyglot-code-intelligence-index.ts";
import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { SymbolIndexPort } from "../code-intelligence/symbol-index-port.ts";
import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";

/** A SymbolIndexPort the registry can shut down when its workspace goes cold. */
export type ClosableSymbolIndex = SymbolIndexPort & { close(): Promise<void> };

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

export type WarmIndexPoolEvent =
	| { readonly kind: "admission-evicted"; readonly languageId: string }
	| { readonly kind: "close-failed"; readonly reason: "admission" | "idle-reap"; readonly languageId: string; readonly errorName: string };

export interface WarmIndexRegistryOptions<WorkspaceKey extends string> {
	readonly descriptors: readonly LanguageServerDescriptor[];
	readonly resolveRoot: (workspaceId: WorkspaceKey) => string;
	readonly createIndex: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
	readonly unsupportedLanguage?: (path: string) => Error;
	readonly now?: () => number;
	readonly maxActive?: number;
	readonly languageLimits?: Readonly<Record<string, number>>;
	readonly observe?: (event: WarmIndexPoolEvent) => void;
}

interface WarmIndexEntry<WorkspaceKey extends string> {
	readonly index: ClosableSymbolIndex;
	readonly workspaceId: WorkspaceKey;
	readonly languageId: string;
	readonly sequence: number;
	activeLeases: number;
	lastUsedAt: number;
}

export interface WarmIndexPoolStatus {
	readonly active: number;
	readonly leased: number;
	readonly maxActive: number;
	readonly byLanguage: Readonly<Record<string, number>>;
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

	constructor(private readonly options: WarmIndexRegistryOptions<WorkspaceKey>) {
		this.now = options.now ?? Date.now;
		this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
		this.languageLimits = options.languageLimits ?? DEFAULT_LANGUAGE_LIMITS;
		if (!Number.isSafeInteger(this.maxActive) || this.maxActive < 1) throw new TypeError("maxActive must be a positive safe integer");
		for (const [languageId, limit] of Object.entries(this.languageLimits)) {
			if (!languageId || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError("language limits must be positive safe integers keyed by language id");
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

	private leastRecentlyUsedIdle(languageId?: string): [string, WarmIndexEntry<WorkspaceKey>] | undefined {
		let selected: [string, WarmIndexEntry<WorkspaceKey>] | undefined;
		for (const candidate of this.entries) {
			const entry = candidate[1];
			if (entry.activeLeases > 0 || (languageId !== undefined && entry.languageId !== languageId)) continue;
			const current = selected?.[1];
			if (!current || entry.lastUsedAt < current.lastUsedAt || (entry.lastUsedAt === current.lastUsedAt && entry.sequence < current.sequence))
				selected = candidate;
		}
		return selected;
	}

	private async evict(entry: [string, WarmIndexEntry<WorkspaceKey>]): Promise<void> {
		try {
			await entry[1].index.close();
		} catch (error) {
			this.options.observe?.({
				kind: "close-failed",
				reason: "admission",
				languageId: entry[1].languageId,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			throw error;
		}
		this.entries.delete(entry[0]);
		this.options.observe?.({ kind: "admission-evicted", languageId: entry[1].languageId });
	}

	private async admit(
		workspaceId: WorkspaceKey,
		rootPath: string,
		descriptor: LanguageServerDescriptor,
		seedFile?: string,
	): Promise<WarmIndexEntry<WorkspaceKey>> {
		const languageLimit = this.languageLimit(descriptor.languageId);
		while (this.countLanguage(descriptor.languageId) >= languageLimit) {
			const victim = this.leastRecentlyUsedIdle(descriptor.languageId);
			if (!victim) throw new WarmIndexCapacityExceeded(descriptor.languageId, this.maxActive, languageLimit);
			await this.evict(victim);
		}
		while (this.entries.size >= this.maxActive) {
			const victim = this.leastRecentlyUsedIdle();
			if (!victim) throw new WarmIndexCapacityExceeded(descriptor.languageId, this.maxActive, languageLimit);
			await this.evict(victim);
		}
		return {
			index: this.options.createIndex(rootPath, descriptor, seedFile),
			workspaceId,
			languageId: descriptor.languageId,
			sequence: this.nextSequence++,
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
		seedFile?: string,
	): Promise<WarmIndexEntry<WorkspaceKey>> {
		return this.serialized(async () => {
			const key = this.key(workspaceId, descriptor.languageId);
			let entry = this.entries.get(key);
			if (!entry) {
				entry = await this.admit(workspaceId, rootPath, descriptor, seedFile);
				this.entries.set(key, entry);
			}
			entry.activeLeases++;
			return entry;
		});
	}

	private lease<Value>(value: Value, entries: readonly WarmIndexEntry<WorkspaceKey>[]): WarmIndexLease<Value> {
		let released = false;
		return {
			value,
			[Symbol.asyncDispose]: () => {
				if (released) return Promise.resolve();
				released = true;
				const completedAt = this.now();
				for (const entry of entries) {
					entry.activeLeases--;
					entry.lastUsedAt = completedAt;
				}
				return Promise.resolve();
			},
		};
	}

	async leaseWarmIndex(input: { readonly workspaceId: WorkspaceKey; readonly path?: string; readonly seedFile?: string }): Promise<
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
		const entry = await this.acquireLanguageIndex(input.workspaceId, rootPath, descriptor, seedFile);
		return this.lease({ index: entry.index, descriptor }, [entry]);
	}

	async leaseWorkspaceIndex(workspaceId: WorkspaceKey, preferredSeedFile?: string): Promise<WarmIndexLease<WorkspaceIndex>> {
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
		return { active: this.entries.size, leased, maxActive: this.maxActive, byLanguage };
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

	async closeAll(): Promise<void> {
		const entries = Array.from(this.entries.values());
		this.entries.clear();
		await Promise.all(entries.map((entry) => entry.index.close()));
	}

	async reapIdle(maxIdleMs: number): Promise<number> {
		const now = this.now();
		const idle = Array.from(this.entries.entries()).filter(([, entry]) => entry.activeLeases === 0 && now - entry.lastUsedAt > maxIdleMs);
		let reaped = 0;
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
		return reaped;
	}
}
