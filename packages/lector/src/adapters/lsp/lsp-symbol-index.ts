import { readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../../domain/call-hierarchy.ts";
import type { CodeRange } from "../../domain/code-range.ts";
import type { Diagnostic, DiagnosticSeverity } from "../../domain/diagnostic.ts";
import type { DocumentSymbolEntry } from "../../domain/document-symbol.ts";
import type { Hover } from "../../domain/hover.ts";
import type { IntelligenceProvenance, SymbolSearchBounds } from "../../domain/intelligence-provenance.ts";
import { DEFAULT_SETTLE_MS, type LanguageServerDescriptor } from "../../domain/language-server-descriptor.ts";
import type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "../../domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "../../ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "../../ports/symbol-index-port.ts";
import { TypeScriptCompilerSymbolIndex } from "../typescript-compiler-symbol-index.ts";
import { resolveSeedFile } from "./discover-seed-file.ts";
import { LanguageServerProcess } from "./language-server-process.ts";

const DEFAULT_MAX_SYMBOL_RESULTS = 1_000;
const DEFAULT_MAX_OPEN_FILES = 256;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SETTLE_MS = 30_000;

export interface LspSymbolIndexOptions {
	readonly maxOpenFiles?: number;
	readonly maxFileBytes?: number;
	readonly maxRefreshBytes?: number;
	readonly maxFallbackSeedFiles?: number;
}

export class LanguageFileOutsideWorkspace extends Error {
	constructor(
		readonly path: string,
		readonly root: string,
	) {
		super(`language file "${path}" resolves outside workspace root "${root}"`);
		this.name = "LanguageFileOutsideWorkspace";
	}
}

export class LanguageFileLimitExceeded extends Error {
	constructor(
		readonly limit: "open-files" | "file-bytes" | "refresh-bytes",
		readonly max: number,
		readonly observed: number,
	) {
		super(`language intelligence ${limit} limit exceeded: ${observed} > ${max}`);
		this.name = "LanguageFileLimitExceeded";
	}
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${field} must be a positive safe integer`);
	return result;
}

const LSP_SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum-member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type-parameter",
};

interface LspSymbolInformation {
	name: string;
	kind: number;
	location: { uri: string; range: { start: { line: number; character: number } } };
	containerName?: string;
}

interface LspPosition {
	line: number;
	character: number;
}

interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

interface LspLocation {
	uri: string;
	range: LspRange;
}

interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange: LspRange;
}

interface LspHover {
	contents: string | { language: string; value: string } | Array<string | { language: string; value: string }> | { kind: string; value: string };
	range?: LspRange;
}

interface LspDocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: LspDocumentSymbol[];
}

interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: string | number;
	source?: string;
	message: string;
}

interface LspCallHierarchyItem {
	name: string;
	kind: number;
	detail?: string;
	uri: string;
	range: LspRange;
	selectionRange: LspRange;
	/** Opaque, server-defined; must be passed back verbatim to callHierarchy/incomingCalls|outgoingCalls. */
	data?: unknown;
}

interface LspCallHierarchyIncomingCall {
	from: LspCallHierarchyItem;
	fromRanges: LspRange[];
}

interface LspCallHierarchyOutgoingCall {
	to: LspCallHierarchyItem;
	fromRanges: LspRange[];
}

interface LspPublishDiagnosticsParams {
	uri: string;
	diagnostics: LspDiagnostic[];
}

/** LSP DiagnosticSeverity is 1-4; the spec recommends treating an absent severity as an error. */
const RUNTIME_EXECUTABLE = realpathSync(process.execPath);

const LSP_DIAGNOSTIC_SEVERITY_NAMES: Readonly<Record<number, DiagnosticSeverity>> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

/** Discriminates the two possible textDocument/documentSymbol response item shapes -- only DocumentSymbol carries `range`. */
function isHierarchicalDocumentSymbol(item: LspDocumentSymbol | LspSymbolInformation): item is LspDocumentSymbol {
	return "range" in item;
}

/** Resolves a descriptor's launch into a spawnable command + args. */
function resolveLanguageServerCommand(descriptor: LanguageServerDescriptor): { command: string; args: string[] } {
	if (descriptor.launch.kind === "npm-module") {
		return { command: RUNTIME_EXECUTABLE, args: [fileURLToPath(import.meta.resolve(descriptor.launch.entryModule)), ...descriptor.args] };
	}
	return { command: descriptor.launch.command, args: [...descriptor.args] };
}

/** LSP positions are 0-indexed; WorkspaceLocation/CodeRange are 1-indexed (doc convention: humans and CLIs present positions 1-indexed). */
function toLspPosition(line: number, character: number): LspPosition {
	return { line: line - 1, character: character - 1 };
}

function fromLspPosition(position: LspPosition): { line: number; character: number } {
	return { line: position.line + 1, character: position.character + 1 };
}

function toWorkspaceLocation(uri: string, position: LspPosition): WorkspaceLocation {
	const { line, character } = fromLspPosition(position);
	return { path: fileURLToPath(uri), line, character };
}

function toCodeRange(path: string, range: LspRange): CodeRange {
	return { path, start: fromLspPosition(range.start), end: fromLspPosition(range.end) };
}

function isLocationLink(item: LspLocation | LspLocationLink): item is LspLocationLink {
	return "targetUri" in item;
}

/** Normalizes definition/declaration/typeDefinition/implementation's Location | Location[] | LocationLink[] | null into one shape. */
function normalizeLocations(result: LspLocation | LspLocation[] | LspLocationLink[] | null): WorkspaceLocation[] {
	if (!result) return [];
	const items = Array.isArray(result) ? result : [result];
	return items.map((item) =>
		isLocationLink(item) ? toWorkspaceLocation(item.targetUri, item.targetSelectionRange.start) : toWorkspaceLocation(item.uri, item.range.start),
	);
}

/** Flattens Hover.contents' three possible LSP shapes (MarkupContent, MarkedString, MarkedString[]) to one string. */
function normalizeHoverContents(contents: LspHover["contents"]): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map((item) => (typeof item === "string" ? item : `\`\`\`${item.language}\n${item.value}\n\`\`\``)).join("\n\n");
	if ("language" in contents) return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
	return contents.value;
}

function normalizeCallHierarchyItem(item: LspCallHierarchyItem): CallHierarchyEntry {
	const path = fileURLToPath(item.uri);
	return {
		name: item.name,
		kind: LSP_SYMBOL_KIND_NAMES[item.kind] ?? "unknown",
		detail: item.detail,
		location: toWorkspaceLocation(item.uri, item.selectionRange.start),
		range: toCodeRange(path, item.range),
	};
}

function normalizeDiagnostic(path: string, item: LspDiagnostic): Diagnostic {
	return {
		range: toCodeRange(path, item.range),
		severity: LSP_DIAGNOSTIC_SEVERITY_NAMES[item.severity ?? 1] ?? "error",
		message: item.message,
		source: item.source,
		code: item.code,
	};
}

function normalizeDocumentSymbol(path: string, item: LspDocumentSymbol | LspSymbolInformation): DocumentSymbolEntry {
	const kind = LSP_SYMBOL_KIND_NAMES[item.kind] ?? "unknown";
	if (isHierarchicalDocumentSymbol(item)) {
		return {
			name: item.name,
			kind,
			detail: item.detail,
			range: toCodeRange(path, item.range),
			selectionRange: toCodeRange(path, item.selectionRange),
			children: item.children?.map((child) => normalizeDocumentSymbol(path, child)),
		};
	}
	// Flat SymbolInformation fallback (a server that ignored hierarchicalDocumentSymbolSupport): no real
	// selectionRange exists, so range and selectionRange both point at the same location -- not fabricated
	// precision, an honest "this is all the server gave us."
	const range = toCodeRange(path, { start: item.location.range.start, end: item.location.range.start });
	return { name: item.name, kind, range, selectionRange: range };
}

/**
 * SymbolIndexPort + CodeIntelligencePort over one warm LSP server process per
 * workspace, driven by a LanguageServerDescriptor rather than a hardcoded
 * language -- the same class serves TypeScript, Python, or any future
 * language whose descriptor is supplied. Lazily spawned on first use; the
 * caller closes it.
 *
 * A real LSP server only answers `workspace/symbol` for a project it has
 * loaded, and a project loads only once one of its files is opened via
 * `didOpen` -- `seedFile` names that file (auto-picked via discoverSeedFile()
 * when omitted). Position/file-based operations need their own target file
 * opened the same way, plus a settle wait (descriptor.settleMs) before the
 * server answers accurately about it; most servers have no "fully checked"
 * signal to poll instead. findReferences only searches files the server has
 * actually loaded -- open a file first to guarantee its usages are included.
 */
export class LspSymbolIndex implements SymbolIndexPort, CodeIntelligencePort {
	readonly provenance: IntelligenceProvenance;
	private readonly cwd: string;
	private readonly canonicalCwd: string;
	private readonly descriptor: LanguageServerDescriptor;
	private readonly explicitSeedFile: string | undefined;
	private fallbackSeedFile: string | undefined;
	private readonly maxOpenFiles: number;
	private readonly maxFileBytes: number;
	private readonly maxRefreshBytes: number;
	private readonly maxFallbackSeedFiles: number;
	private readonly openedFiles = new Map<string, { version: number; content: string }>();
	private readonly latestDiagnostics = new Map<string, Diagnostic[]>();
	private readonly diagnosticsWaiters = new Map<string, Array<() => void>>();
	private process: LanguageServerProcess | undefined;
	private initializing: Promise<LanguageServerProcess> | undefined;

	constructor(cwd: string, descriptor: LanguageServerDescriptor, seedFile?: string, options: LspSymbolIndexOptions = {}) {
		this.cwd = resolve(cwd);
		this.canonicalCwd = realpathSync(this.cwd);
		this.descriptor = descriptor;
		this.explicitSeedFile = seedFile;
		this.maxOpenFiles = positiveLimit(options.maxOpenFiles, DEFAULT_MAX_OPEN_FILES, "maxOpenFiles");
		this.maxFileBytes = positiveLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
		this.maxRefreshBytes = positiveLimit(options.maxRefreshBytes, 50 * 1024 * 1024, "maxRefreshBytes");
		this.maxFallbackSeedFiles = positiveLimit(options.maxFallbackSeedFiles, 8, "maxFallbackSeedFiles");
		const settleMs = descriptor.settleMs ?? DEFAULT_SETTLE_MS;
		if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > MAX_SETTLE_MS)
			throw new TypeError(`settleMs must be an integer from 0 through ${MAX_SETTLE_MS}`);
		this.provenance = {
			fidelity: "semantic",
			backend: descriptor.backendId,
			languageId: descriptor.languageId,
			authority: "language-server",
			freshness: "live-process",
			limitations: [],
		};
	}

	/** Undefined before the server process has been spawned (first real query). */
	get processId(): number | undefined {
		return this.process?.pid;
	}

	private resolveTargetPath(path: string): string {
		const absolute = resolve(this.cwd, path);
		const canonical = realpathSync(absolute);
		const relativeToRoot = relative(this.canonicalCwd, canonical);
		if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
			throw new LanguageFileOutsideWorkspace(path, this.cwd);
		}
		return absolute;
	}

	private async ensureInitialized(initialPath?: string): Promise<LanguageServerProcess> {
		const initialTargetPath = initialPath ? this.resolveTargetPath(initialPath) : undefined;
		if (this.process) return this.process;
		if (!this.initializing) {
			let spawned: LanguageServerProcess | undefined;
			this.initializing = (async () => {
				const proc = LanguageServerProcess.spawnProcess({
					...resolveLanguageServerCommand(this.descriptor),
					cwd: this.cwd,
				});
				spawned = proc;
				proc.onNotification("textDocument/publishDiagnostics", (params) => {
					const { uri, diagnostics } = params as LspPublishDiagnosticsParams;
					const path = fileURLToPath(uri);
					this.latestDiagnostics.set(
						path,
						diagnostics.map((item) => normalizeDiagnostic(path, item)),
					);
					const waiters = this.diagnosticsWaiters.get(path);
					if (waiters) {
						this.diagnosticsWaiters.delete(path);
						for (const resolve of waiters) resolve();
					}
				});
				await proc.request("initialize", {
					processId: process.pid,
					rootUri: pathToFileURL(this.cwd).href,
					// pyright needs this to resolve its own workspace root -- without it, workspace/symbol
					// silently returns [] forever, even though rootUri alone is enough for tsserver/gopls.
					workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
					capabilities: {
						textDocument: {
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
							definition: { linkSupport: true },
							hover: { contentFormat: ["markdown", "plaintext"] },
							...this.descriptor.extraCapabilities,
						},
					},
					initializationOptions: {},
				});
				proc.notify("initialized", {});

				const configuredSeedFile = this.fallbackSeedFile ?? this.explicitSeedFile;
				const seedPath = configuredSeedFile
					? resolve(this.cwd, configuredSeedFile)
					: (initialTargetPath ?? resolve(this.cwd, resolveSeedFile(this.cwd, this.descriptor)));
				await this.ensureFileOpen(proc, seedPath);

				this.process = proc;
				return proc;
			})().catch(async (error: unknown) => {
				await spawned?.stop();
				// A failed initialize must not permanently poison this workspace's index --
				// the next call retries fresh rather than replaying the same rejection forever.
				this.initializing = undefined;
				throw error;
			});
		}
		return this.initializing;
	}

	private readBoundedFile(path: string): string {
		const content = readFileSync(path);
		if (content.byteLength > this.maxFileBytes) throw new LanguageFileLimitExceeded("file-bytes", this.maxFileBytes, content.byteLength);
		return content.toString("utf-8");
	}

	/**
	 * Opens a file or sends a monotonic full-document change when its disk content
	 * changed since the prior query, then waits the settle period before returning.
	 *
	 * `settleMsOverride` lets a caller that has already validated correctness at its
	 * own reduced settle time skip the descriptor's normal, more conservative default
	 * -- see populateSymbolGraph's own use via documentSymbols/outgoingCalls's options.
	 * Confirmed empirically (real fixtures, byte-identical results across repeated
	 * runs at real scale) that a bulk documentSymbols+outgoingCalls crawl is correct
	 * with zero settle even on a file never opened before; goToDefinition/hover are
	 * NOT -- immediately after opening, they can return a shallow "import statement"
	 * answer instead of following through to the real cross-file declaration, because
	 * that resolution depends on the server having caught up on the imported file's
	 * own analysis, which the settle wait is what actually buys. Never widen this
	 * override to goToDefinition/hover/findReferences/diagnostics without repeating
	 * that same validation -- it's a real, measured correctness boundary, not an
	 * arbitrary one.
	 */
	private async ensureFileOpen(proc: LanguageServerProcess, path: string, settleMsOverride?: number): Promise<void> {
		const settleMs = settleMsOverride ?? this.descriptor.settleMs ?? DEFAULT_SETTLE_MS;
		if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > MAX_SETTLE_MS)
			throw new TypeError(`settleMs must be an integer from 0 through ${MAX_SETTLE_MS}`);
		path = this.resolveTargetPath(path);
		const content = this.readBoundedFile(path);
		const opened = this.openedFiles.get(path);
		if (opened?.content === content) return;
		if (!opened) {
			if (this.openedFiles.size >= this.maxOpenFiles) throw new LanguageFileLimitExceeded("open-files", this.maxOpenFiles, this.openedFiles.size + 1);
			proc.notify("textDocument/didOpen", {
				textDocument: {
					uri: pathToFileURL(path).href,
					languageId: this.descriptor.documentLanguageIds?.[extname(path)] ?? this.descriptor.languageId,
					version: 1,
					text: content,
				},
			});
			this.openedFiles.set(path, { version: 1, content });
		} else {
			const version = opened.version + 1;
			this.latestDiagnostics.delete(path);
			proc.notify("textDocument/didChange", {
				textDocument: { uri: pathToFileURL(path).href, version },
				contentChanges: [{ text: content }],
			});
			this.openedFiles.set(path, { version, content });
		}
		await new Promise((resolve) => setTimeout(resolve, settleMs));
	}

	/**
	 * Closes `path` if this index has it open, freeing its open-file slot for
	 * a bulk crawl's next file. A no-op if the process was never started or
	 * the file was never opened -- never throws for something this method
	 * would only have needed to fix anyway. A later real operation against
	 * the same path reopens it transparently via ensureFileOpen.
	 */
	releaseFile(path: string): Promise<void> {
		path = this.resolveTargetPath(path);
		if (!this.openedFiles.has(path)) return Promise.resolve();
		const proc = this.process;
		if (proc) proc.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(path).href } });
		this.openedFiles.delete(path);
		this.latestDiagnostics.delete(path);
		this.diagnosticsWaiters.delete(path);
		return Promise.resolve();
	}

	/** Resolves as soon as `path`'s next publishDiagnostics notification lands, or after `timeoutMs` -- diagnostics are server-pushed, never a request/response Lector can just await. */
	private waitForDiagnosticsNotification(path: string, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			const waiters = this.diagnosticsWaiters.get(path) ?? [];
			waiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
			this.diagnosticsWaiters.set(path, waiters);
		});
	}

	private async restartForSeed(seedFile: string): Promise<LanguageServerProcess> {
		await this.process?.stop();
		this.process = undefined;
		this.initializing = undefined;
		this.openedFiles.clear();
		this.latestDiagnostics.clear();
		this.diagnosticsWaiters.clear();
		this.fallbackSeedFile = seedFile;
		return this.ensureInitialized();
	}

	async findSymbols(query: string, bounds: SymbolSearchBounds = { maxResults: DEFAULT_MAX_SYMBOL_RESULTS }): Promise<SymbolSearchResult> {
		if (!Number.isSafeInteger(bounds.maxResults) || bounds.maxResults < 1) throw new TypeError("maxResults must be a positive safe integer");
		let proc = await this.ensureInitialized();
		let refreshedBytes = 0;
		for (const path of this.openedFiles.keys()) {
			await this.ensureFileOpen(proc, path);
			refreshedBytes += Buffer.byteLength(this.openedFiles.get(path)?.content ?? "", "utf-8");
			if (refreshedBytes > this.maxRefreshBytes) throw new LanguageFileLimitExceeded("refresh-bytes", this.maxRefreshBytes, refreshedBytes);
		}
		let results = (await proc.request<LspSymbolInformation[] | null>("workspace/symbol", { query })) ?? [];
		if (results.length === 0 && this.descriptor.languageId === "typescript") {
			const candidates = await new TypeScriptCompilerSymbolIndex(this.cwd, { maxResults: this.maxFallbackSeedFiles }).findSymbols(query, {
				maxResults: this.maxFallbackSeedFiles,
			});
			const candidate = candidates.symbols[0];
			if (candidate) {
				proc = await this.restartForSeed(candidate.location.path);
				results = (await proc.request<LspSymbolInformation[] | null>("workspace/symbol", { query })) ?? [];
			}
		}
		const truncated = results.length > bounds.maxResults;
		const symbols: WorkspaceSymbol[] = results.slice(0, bounds.maxResults).map((symbol) => ({
			name: symbol.name,
			kind: LSP_SYMBOL_KIND_NAMES[symbol.kind] ?? "unknown",
			location: {
				path: fileURLToPath(symbol.location.uri),
				line: symbol.location.range.start.line + 1,
				character: symbol.location.range.start.character + 1,
			},
			containerName: symbol.containerName,
		}));
		return { symbols, truncated, provenance: this.provenance };
	}

	async goToDefinition(at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
		const proc = await this.ensureInitialized(at.path);
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<LspLocation | LspLocation[] | LspLocationLink[] | null>("textDocument/definition", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		return normalizeLocations(result);
	}

	async goToImplementation(at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
		const proc = await this.ensureInitialized(at.path);
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<LspLocation | LspLocation[] | LspLocationLink[] | null>("textDocument/implementation", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		return normalizeLocations(result);
	}

	async findReferences(at: WorkspaceLocation, includeDeclaration: boolean): Promise<WorkspaceLocation[]> {
		const proc = await this.ensureInitialized(at.path);
		await this.ensureFileOpen(proc, at.path);
		const results =
			(await proc.request<LspLocation[] | null>("textDocument/references", {
				textDocument: { uri: pathToFileURL(at.path).href },
				position: toLspPosition(at.line, at.character),
				context: { includeDeclaration },
			})) ?? [];
		return results.map((location) => toWorkspaceLocation(location.uri, location.range.start));
	}

	async hover(at: WorkspaceLocation): Promise<Hover | undefined> {
		const proc = await this.ensureInitialized(at.path);
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<LspHover | null>("textDocument/hover", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		if (!result) return undefined;
		return { contents: normalizeHoverContents(result.contents), range: result.range ? toCodeRange(at.path, result.range) : undefined };
	}

	async documentSymbols(path: string, options?: { settleMs?: number }): Promise<DocumentSymbolEntry[]> {
		const proc = await this.ensureInitialized(path);
		await this.ensureFileOpen(proc, path, options?.settleMs);
		const results =
			(await proc.request<(LspDocumentSymbol | LspSymbolInformation)[] | null>("textDocument/documentSymbol", {
				textDocument: { uri: pathToFileURL(path).href },
			})) ?? [];
		return results.map((item) => normalizeDocumentSymbol(path, item));
	}

	async diagnostics(path: string): Promise<Diagnostic[]> {
		const proc = await this.ensureInitialized(path);
		await this.ensureFileOpen(proc, path);
		if (!this.latestDiagnostics.has(path)) await this.waitForDiagnosticsNotification(path, 5000);
		return this.latestDiagnostics.get(path) ?? [];
	}

	/** Raw LSP items, `data` intact -- callHierarchy/incomingCalls|outgoingCalls need the exact item prepareCallHierarchy returned, not a normalized copy. */
	private async prepareCallHierarchyRaw(proc: LanguageServerProcess, at: WorkspaceLocation, settleMsOverride?: number): Promise<LspCallHierarchyItem[]> {
		await this.ensureFileOpen(proc, at.path, settleMsOverride);
		const result = await proc.request<LspCallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		return result ?? [];
	}

	async prepareCallHierarchy(at: WorkspaceLocation): Promise<CallHierarchyEntry[]> {
		const proc = await this.ensureInitialized(at.path);
		const items = await this.prepareCallHierarchyRaw(proc, at);
		return items.map((item) => normalizeCallHierarchyItem(item));
	}

	async incomingCalls(at: WorkspaceLocation): Promise<IncomingCall[]> {
		const proc = await this.ensureInitialized(at.path);
		const root = (await this.prepareCallHierarchyRaw(proc, at))[0];
		if (!root) return [];
		const results = (await proc.request<LspCallHierarchyIncomingCall[] | null>("callHierarchy/incomingCalls", { item: root })) ?? [];
		return results.map((result) => ({
			from: normalizeCallHierarchyItem(result.from),
			fromRanges: result.fromRanges.map((range) => toCodeRange(fileURLToPath(result.from.uri), range)),
		}));
	}

	async outgoingCalls(at: WorkspaceLocation, options?: { settleMs?: number }): Promise<OutgoingCall[]> {
		const proc = await this.ensureInitialized(at.path);
		const root = (await this.prepareCallHierarchyRaw(proc, at, options?.settleMs))[0];
		if (!root) return [];
		const results = (await proc.request<LspCallHierarchyOutgoingCall[] | null>("callHierarchy/outgoingCalls", { item: root })) ?? [];
		// fromRanges here are relative to `root` (the item passed to the request), per spec -- not `to`.
		const rootPath = fileURLToPath(root.uri);
		return results.map((result) => ({
			to: normalizeCallHierarchyItem(result.to),
			fromRanges: result.fromRanges.map((range) => toCodeRange(rootPath, range)),
		}));
	}

	async close(): Promise<void> {
		const initializing = this.initializing;
		const process = this.process ?? (initializing ? await initializing.catch(() => undefined) : undefined);
		await process?.stop();
		this.process = undefined;
		this.initializing = undefined;
		this.openedFiles.clear();
		this.latestDiagnostics.clear();
		this.diagnosticsWaiters.clear();
	}
}
