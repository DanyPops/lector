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

export interface WarmIndexRegistryOptions<WorkspaceKey extends string> {
	readonly descriptors: readonly LanguageServerDescriptor[];
	readonly resolveRoot: (workspaceId: WorkspaceKey) => string;
	readonly createIndex: (rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string) => ClosableSymbolIndex;
	readonly unsupportedLanguage?: (path: string) => Error;
	readonly now?: () => number;
}

interface WarmIndexEntry<WorkspaceKey extends string> {
	readonly index: ClosableSymbolIndex;
	readonly workspaceId: WorkspaceKey;
	lastUsedAt: number;
}

/** Owns the complete lifecycle of warm per-workspace, per-language symbol indexes. */
export class WarmIndexRegistry<WorkspaceKey extends string> {
	private readonly entries = new Map<string, WarmIndexEntry<WorkspaceKey>>();
	private readonly now: () => number;

	constructor(private readonly options: WarmIndexRegistryOptions<WorkspaceKey>) {
		this.now = options.now ?? Date.now;
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

	ensureLanguageIndex(workspaceId: WorkspaceKey, rootPath: string, descriptor: LanguageServerDescriptor, seedFile?: string): ClosableSymbolIndex {
		const key = this.key(workspaceId, descriptor.languageId);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { index: this.options.createIndex(rootPath, descriptor, seedFile), workspaceId, lastUsedAt: this.now() };
			this.entries.set(key, entry);
		} else {
			entry.lastUsedAt = this.now();
		}
		return entry.index;
	}

	ensureWarmIndex(input: { readonly workspaceId: WorkspaceKey; readonly path?: string; readonly seedFile?: string }): {
		index: ClosableSymbolIndex;
		descriptor: LanguageServerDescriptor;
	} {
		const rootPath = this.options.resolveRoot(input.workspaceId);
		const pathHint = input.path ?? input.seedFile;
		if (pathHint) {
			const descriptor = this.descriptorForPath(pathHint);
			if (!descriptor) throw this.unsupportedLanguage(pathHint);
			return { index: this.ensureLanguageIndex(input.workspaceId, rootPath, descriptor, input.seedFile), descriptor };
		}
		const discovered = discoverWorkspaceDescriptor(rootPath, this.options.descriptors);
		if (!discovered) throw this.unsupportedLanguage(rootPath);
		return {
			index: this.ensureLanguageIndex(input.workspaceId, rootPath, discovered.descriptor, discovered.seedFile),
			descriptor: discovered.descriptor,
		};
	}

	ensureWorkspaceIndex(
		workspaceId: WorkspaceKey,
		preferredSeedFile?: string,
	): { index: SymbolIndexPort; descriptors: readonly LanguageServerDescriptor[]; sources: readonly IntelligenceProvenance[] } {
		const rootPath = this.options.resolveRoot(workspaceId);
		const preferredDescriptor = preferredSeedFile ? this.descriptorForPath(preferredSeedFile) : undefined;
		if (preferredSeedFile && !preferredDescriptor) throw this.unsupportedLanguage(preferredSeedFile);
		const discovered = [...discoverWorkspaceDescriptors(rootPath, this.options.descriptors)];
		if (preferredDescriptor && preferredSeedFile && !discovered.some(({ descriptor }) => descriptor.languageId === preferredDescriptor.languageId)) {
			discovered.push({ descriptor: preferredDescriptor, seedFile: preferredSeedFile });
		}
		if (discovered.length === 0) throw this.unsupportedLanguage(rootPath);
		const indexes = discovered.map(({ descriptor, seedFile }) => ({
			descriptor,
			index: this.ensureLanguageIndex(
				workspaceId,
				rootPath,
				descriptor,
				preferredDescriptor?.languageId === descriptor.languageId ? preferredSeedFile : seedFile,
			),
		}));
		const first = indexes[0];
		const index: SymbolIndexPort = indexes.length === 1 && first ? first.index : new PolyglotCodeIntelligenceIndex(indexes);
		return { index, descriptors: discovered.map(({ descriptor }) => descriptor), sources: indexes.map(({ index: source }) => source.provenance) };
	}

	sourceExtensions(descriptors: readonly LanguageServerDescriptor[]): readonly string[] {
		return Array.from(new Set(descriptors.flatMap((descriptor) => descriptor.extensions)));
	}

	hasWarmIndex(workspaceId: WorkspaceKey, path?: string): boolean {
		if (path) {
			const descriptor = this.descriptorForPath(path);
			return descriptor ? this.entries.has(this.key(workspaceId, descriptor.languageId)) : false;
		}
		for (const entry of this.entries.values()) {
			if (entry.workspaceId === workspaceId) return true;
		}
		return false;
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
		const idle = Array.from(this.entries.entries()).filter(([, entry]) => now - entry.lastUsedAt > maxIdleMs);
		for (const [key] of idle) this.entries.delete(key);
		await Promise.all(idle.map(([, entry]) => entry.index.close()));
		return idle.length;
	}
}
