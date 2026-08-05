import { readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "@danypops/vehicle-server/logging";
import picomatch from "picomatch";
import type { DiagnosticRegistration, FileSystemWatcherPattern } from "../../concurrency/dynamic-capability-registry.ts";
import {
	DynamicCapabilityRegistry,
	parseConfigurationItemCount,
	parseProgressCreateToken,
	parseProgressNotification,
	parseRegistrationRequest,
	parseUnregistrationRequest,
} from "../../concurrency/dynamic-capability-registry.ts";
import { SerialExecutionQueue } from "../../concurrency/serial-execution-queue.ts";
import { InMemoryContentCache } from "../../content-cache/in-memory-content-cache.ts";
import type { ContentCachePort } from "../../content-cache/port.ts";
import { contentHashOf } from "../../content-identity/content-hash.ts";
import type { CodeRange } from "../../domain/code-range.ts";
import { type Diagnostic, type DiagnosticSeverity, mergeDiagnostics } from "../../domain/diagnostic.ts";
import type { DocumentSymbolEntry } from "../../domain/document-symbol.ts";
import type { Hover } from "../../domain/hover.ts";
import type { IntelligenceProvenance, SymbolSearchBounds } from "../../domain/intelligence-provenance.ts";
import { DEFAULT_SETTLE_MS, type LanguageServerDescriptor } from "../../domain/language-server-descriptor.ts";
import { toLspFileChangeType } from "../../domain/lsp-file-change-type.ts";
import { type ParsedServerCapabilities, parseServerCapabilities, shouldSyncDocuments } from "../../domain/lsp-server-capabilities.ts";
import { type ParsedWorkspaceEdit, parsePrepareRenameResult, parseWorkspaceEdit, type RenameRange } from "../../domain/workspace-edit.ts";
import type { SymbolSearchResult, WorkspaceLocation, WorkspaceSymbol } from "../../domain/workspace-symbol.ts";
import type { FileChangeEvent } from "../../file-watcher/file-change-event.ts";
import type { LanguageServerProvisionerPort } from "../../lsp-provisioning/port.ts";
import type { CodeIntelligencePort } from "../../ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "../../ports/symbol-index-port.ts";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../../symbol-graph/call-hierarchy.ts";
import { TypeScriptCompilerSymbolIndex } from "../typescript-compiler-symbol-index.ts";
import { resolveSeedFile } from "./discover-seed-file.ts";
import { LanguageServerProcess } from "./language-server-process.ts";

const DEFAULT_MAX_SYMBOL_RESULTS = 1_000;
const DEFAULT_MAX_OPEN_FILES = 256;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SETTLE_MS = 30_000;

const NOOP_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface LspSymbolIndexOptions {
	readonly maxOpenFiles?: number;
	/** Debug on every open/release, warn when ensureFileOpen rejects at the cap. Defaults to a no-op. */
	readonly logger?: Logger;
	readonly maxFileBytes?: number;
	readonly maxRefreshBytes?: number;
	readonly maxFallbackSeedFiles?: number;
	/**
	 * Shared with rawRead/exactEdit and TreeSitterSymbolIndex when the service supplies one
	 * common instance -- the same physical file read by any of them warms the same
	 * content-addressed entry for the others, instead of each independently caching (or not
	 * caching at all) its own private view of the same bytes. Defaults to a private,
	 * unshared cache when not given, for full backward compatibility.
	 */
	readonly contentCache?: ContentCachePort;
	/** Optional managed installer used only when a provisionable system binary is absent from PATH. */
	readonly provisioner?: LanguageServerProvisionerPort;
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

export class LanguageServerProvisioningUnavailable extends Error {
	constructor(
		readonly backendId: string,
		readonly reason: string,
	) {
		super(`language server ${backendId} is unavailable and managed provisioning failed: ${reason}`);
		this.name = "LanguageServerProvisioningUnavailable";
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseLspPosition(value: unknown): LspPosition | undefined {
	if (!isRecord(value) || typeof value.line !== "number" || typeof value.character !== "number") return undefined;
	return { line: value.line, character: value.character };
}

function parseLspRange(value: unknown): LspRange | undefined {
	if (!isRecord(value)) return undefined;
	const start = parseLspPosition(value.start);
	const end = parseLspPosition(value.end);
	if (!start || !end) return undefined;
	return { start, end };
}

function parseLspDiagnostic(value: unknown): LspDiagnostic | undefined {
	if (!isRecord(value) || typeof value.message !== "string") return undefined;
	const range = parseLspRange(value.range);
	if (!range) return undefined;
	return {
		range,
		message: value.message,
		severity: typeof value.severity === "number" ? value.severity : undefined,
		code: typeof value.code === "string" || typeof value.code === "number" ? value.code : undefined,
		source: typeof value.source === "string" ? value.source : undefined,
	};
}

/**
 * Parses textDocument/publishDiagnostics' params. A malformed envelope
 * (missing uri/diagnostics) yields undefined; a malformed individual
 * diagnostic entry is skipped rather than discarding the whole batch --
 * either way, an unexpected shape from a misbehaving server must never
 * throw and crash the whole connection via LanguageServerProcess's own
 * catch-and-fail around every dispatched message.
 */
function parsePublishDiagnosticsParams(params: unknown): LspPublishDiagnosticsParams | undefined {
	if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return undefined;
	const diagnostics: LspDiagnostic[] = [];
	for (const item of params.diagnostics) {
		const diagnostic = parseLspDiagnostic(item);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return { uri: params.uri, diagnostics };
}

/** DocumentDiagnosticReport: textDocument/diagnostic's response. "unchanged" means the server's prior report (identified by resultId) is still current -- Lector always requests fresh (no previousResultId sent), so it never receives "unchanged" in practice, but must still not crash if a server sends one anyway. */
interface LspFullDocumentDiagnosticReport {
	kind: "full";
	resultId?: string;
	items: LspDiagnostic[];
}
interface LspUnchangedDocumentDiagnosticReport {
	kind: "unchanged";
	resultId: string;
}
type LspDocumentDiagnosticReport = LspFullDocumentDiagnosticReport | LspUnchangedDocumentDiagnosticReport;

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

function isMissingExecutable(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
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
	private negotiatedCapabilities: ParsedServerCapabilities | undefined;
	private dynamicCapabilities = new DynamicCapabilityRegistry();
	/** Serializes mutation-dependent operations per file path -- two concurrent queries touching the same file must never race textDocument/didChange's version bookkeeping. */
	private readonly mutationQueue = new SerialExecutionQueue();
	private readonly contentCache: ContentCachePort;
	private readonly logger: Logger;
	private readonly provisioner: LanguageServerProvisionerPort | undefined;

	constructor(cwd: string, descriptor: LanguageServerDescriptor, seedFile?: string, options: LspSymbolIndexOptions = {}) {
		this.cwd = resolve(cwd);
		this.canonicalCwd = realpathSync(this.cwd);
		this.descriptor = descriptor;
		this.explicitSeedFile = seedFile;
		this.contentCache = options.contentCache ?? new InMemoryContentCache();
		this.logger = options.logger ?? NOOP_LOGGER;
		this.provisioner = options.provisioner;
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

	private configureProcess(proc: LanguageServerProcess): void {
		this.dynamicCapabilities = new DynamicCapabilityRegistry();
		proc.onNotification("textDocument/publishDiagnostics", (params) => {
			const parsed = parsePublishDiagnosticsParams(params);
			if (!parsed) return;
			const { uri, diagnostics } = parsed;
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
		this.registerServerInitiatedRequestHandlers(proc);
		proc.onNotification("$/progress", (params) => {
			const progress = parseProgressNotification(params);
			if (progress) this.dynamicCapabilities.recordProgress(progress.token, progress.value);
		});
	}

	private requestInitialize(proc: LanguageServerProcess): Promise<{ capabilities?: unknown }> {
		return proc.request("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(this.cwd).href,
			workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
			capabilities: {
				textDocument: {
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					definition: { linkSupport: true },
					hover: { contentFormat: ["markdown", "plaintext"] },
					rename: { prepareSupport: true },
					diagnostic: { dynamicRegistration: true },
					...this.descriptor.extraCapabilities,
				},
				window: { workDoneProgress: true },
				workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
			},
			initializationOptions: {},
		});
	}

	private async provisionMissingServer(): Promise<string> {
		if (!this.provisioner) throw new LanguageServerProvisioningUnavailable(this.descriptor.backendId, "no provisioner is configured");
		if (!this.descriptor.provisioning) throw new LanguageServerProvisioningUnavailable(this.descriptor.backendId, "no managed source is configured");
		this.logger.info("language server provisioning started", { component: "lsp", operation: "provision", backendId: this.descriptor.backendId });
		const outcome = await this.provisioner.ensureInstalled({ id: this.descriptor.backendId, source: this.descriptor.provisioning });
		switch (outcome.kind) {
			case "installed":
			case "already-installed":
				this.logger.info("language server provisioning ready", {
					component: "lsp",
					operation: "provision",
					backendId: this.descriptor.backendId,
					outcome: outcome.kind,
				});
				return outcome.binPath;
			case "unavailable":
				this.logger.warn("language server provisioning unavailable", { component: "lsp", operation: "provision", backendId: this.descriptor.backendId });
				throw new LanguageServerProvisioningUnavailable(this.descriptor.backendId, outcome.reason);
			case "timed-out":
				this.logger.warn("language server provisioning timed out", { component: "lsp", operation: "provision", backendId: this.descriptor.backendId });
				throw new LanguageServerProvisioningUnavailable(this.descriptor.backendId, "installation timed out");
			default: {
				const exhaustive: never = outcome;
				throw new TypeError(`unsupported provisioning outcome: ${String(exhaustive)}`);
			}
		}
	}

	private async ensureInitialized(initialPath?: string): Promise<LanguageServerProcess> {
		const initialTargetPath = initialPath ? this.resolveTargetPath(initialPath) : undefined;
		if (this.process) return this.process;
		if (!this.initializing) {
			let spawned: LanguageServerProcess | undefined;
			this.initializing = (async () => {
				let proc = LanguageServerProcess.spawnProcess({
					...resolveLanguageServerCommand(this.descriptor),
					cwd: this.cwd,
				});
				spawned = proc;
				this.configureProcess(proc);
				let initializeResult: { capabilities?: unknown };
				try {
					initializeResult = await this.requestInitialize(proc);
				} catch (error) {
					if (!isMissingExecutable(error) || this.descriptor.launch.kind !== "system-binary" || !this.descriptor.provisioning) throw error;
					await proc.stop();
					const installedCommand = await this.provisionMissingServer();
					proc = LanguageServerProcess.spawnProcess({ command: installedCommand, args: [...this.descriptor.args], cwd: this.cwd });
					spawned = proc;
					this.configureProcess(proc);
					initializeResult = await this.requestInitialize(proc);
				}
				this.negotiatedCapabilities = parseServerCapabilities(initializeResult.capabilities);
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
				this.negotiatedCapabilities = undefined;
				throw error;
			});
		}
		return this.initializing;
	}

	/**
	 * Registers replies for the server-initiated requests a warm LSP session may issue.
	 * Every one of these must answer -- a spec-compliant server blocks waiting for a
	 * reply, so leaving any of them unhandled (falling through to MethodNotFound, the
	 * LanguageServerProcess default) would be a real protocol violation, not a safe gap.
	 */
	private registerServerInitiatedRequestHandlers(proc: LanguageServerProcess): void {
		proc.onRequest("client/registerCapability", (params) => {
			for (const registration of parseRegistrationRequest(params)) {
				this.dynamicCapabilities.register(registration.id, registration.method, registration.registerOptions);
			}
			return null;
		});
		proc.onRequest("client/unregisterCapability", (params) => {
			for (const id of parseUnregistrationRequest(params)) this.dynamicCapabilities.unregister(id);
			return null;
		});
		proc.onRequest("workspace/configuration", (params) => Array.from({ length: parseConfigurationItemCount(params) }, () => null));
		proc.onRequest("workspace/applyEdit", () => ({
			applied: false,
			failureReason: "Lector does not yet support a server-initiated workspace edit",
		}));
		proc.onRequest("window/workDoneProgress/create", (params) => {
			const token = parseProgressCreateToken(params);
			if (token !== undefined) this.dynamicCapabilities.createProgressToken(token);
			return null;
		});
		proc.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }]);
		proc.onRequest("workspace/diagnostic/refresh", () => null);
	}

	/** The capabilities this workspace's server negotiated at `initialize`, or undefined before the first warm session. */
	get capabilities(): ParsedServerCapabilities | undefined {
		return this.negotiatedCapabilities;
	}

	/** Every glob pattern the warm server has dynamically registered via workspace/didChangeWatchedFiles, for a future local watcher to honor. */
	get dynamicWatchedFilePatterns(): readonly FileSystemWatcherPattern[] {
		return this.dynamicCapabilities.watchedFilePatterns;
	}

	/** Every textDocument/diagnostic registration the warm server has made dynamically, post-initialize -- test observability for a registration's own arrival, distinct from diagnostics()'s own internal use of the same registry. */
	get dynamicDiagnosticRegistrations(): readonly DiagnosticRegistration[] {
		return this.dynamicCapabilities.diagnosticRegistrations;
	}

	/** The latest $/progress value reported for every token seen so far (bounded). */
	get latestProgress(): ReadonlyMap<string | number, unknown> {
		return this.dynamicCapabilities.progressByToken;
	}

	/**
	 * Tells the warm server about a real filesystem change via workspace/didChangeWatchedFiles,
	 * if -- and only if -- it dynamically registered interest in a pattern this path matches.
	 * Never spawns a server just to check: this is a best-effort notification for an already-warm
	 * session, matching hasWarmIndex's own "don't pay a cold-start cost just to check" philosophy.
	 * A cold LspSymbolIndex (nothing to tell) or a warm one that never registered any pattern
	 * (nothing it asked to hear about) are both silent no-ops.
	 */
	notifyFileChanged(event: FileChangeEvent): void {
		const proc = this.process;
		if (!proc) return;
		const patterns = this.dynamicCapabilities.watchedFilePatterns;
		if (patterns.length === 0) return;
		if (!patterns.some((pattern) => picomatch(pattern.globPattern)(event.path))) return;
		const absolutePath = resolve(this.cwd, event.path);
		proc.notify("workspace/didChangeWatchedFiles", {
			changes: [{ uri: pathToFileURL(absolutePath).href, type: toLspFileChangeType(event.kind) }],
		});
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
		// Serialized per path: two concurrent callers touching the same file must read the prior
		// version, decide open-vs-change, and write the new version back as one atomic step -- not
		// race each other into sending the server two didChange notifications with the same version.
		return this.mutationQueue.run(path, async () => {
			const content = this.readBoundedFile(path);
			const opened = this.openedFiles.get(path);
			if (opened?.content === content) return;
			// Warmed regardless of open-vs-change below, and regardless of whether this text-sync
			// notification is actually sent to the server (see the "none" sync-kind skip further
			// down) -- rawRead/exactEdit/TreeSitterSymbolIndex reusing this exact content by hash is
			// a real benefit independent of what this particular server negotiated.
			await this.contentCache.putRawContent(contentHashOf(content), content);
			// Preserves the server's own negotiated capability: a server that never declared (or
			// explicitly declared None) textDocumentSync was told, per spec, that it does not track
			// content via these notifications -- bookkeeping (openedFiles/version) still advances so
			// a later call correctly detects "already tracked, unchanged" either way, but no bytes
			// are sent to a server that asked not to receive them. Confirmed empirically that both
			// currently-supported real servers this matters for (typescript-language-server,
			// bash-language-server) explicitly negotiate non-None sync, so this is a real spec-
			// correctness fix with zero observed behavior change today, not a guessed one.
			const sync = shouldSyncDocuments(this.negotiatedCapabilities?.textDocumentSyncKind ?? "full");
			if (!opened) {
				if (this.openedFiles.size >= this.maxOpenFiles) {
					this.logger.warn("open-file limit exceeded", {
						module: "lsp-symbol-index",
						languageId: this.descriptor.languageId,
						cwd: this.cwd,
						path,
						openFiles: this.openedFiles.size,
						maxOpenFiles: this.maxOpenFiles,
					});
					throw new LanguageFileLimitExceeded("open-files", this.maxOpenFiles, this.openedFiles.size + 1);
				}
				if (sync) {
					proc.notify("textDocument/didOpen", {
						textDocument: {
							uri: pathToFileURL(path).href,
							languageId: this.descriptor.documentLanguageIds?.[extname(path)] ?? this.descriptor.languageId,
							version: 1,
							text: content,
						},
					});
				}
				this.openedFiles.set(path, { version: 1, content });
				this.logger.debug("file opened", {
					module: "lsp-symbol-index",
					languageId: this.descriptor.languageId,
					cwd: this.cwd,
					path,
					openFiles: this.openedFiles.size,
					maxOpenFiles: this.maxOpenFiles,
				});
			} else {
				const version = opened.version + 1;
				this.latestDiagnostics.delete(path);
				if (sync) {
					proc.notify("textDocument/didChange", {
						textDocument: { uri: pathToFileURL(path).href, version },
						contentChanges: [{ text: content }],
					});
				}
				this.openedFiles.set(path, { version, content });
			}
			await new Promise((resolve) => setTimeout(resolve, sync ? settleMs : 0));
		});
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
		return this.mutationQueue.run(path, () => {
			if (!this.openedFiles.has(path)) return Promise.resolve();
			const proc = this.process;
			if (proc) proc.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(path).href } });
			this.openedFiles.delete(path);
			this.logger.debug("file released", {
				module: "lsp-symbol-index",
				languageId: this.descriptor.languageId,
				cwd: this.cwd,
				path,
				openFiles: this.openedFiles.size,
				maxOpenFiles: this.maxOpenFiles,
			});
			this.latestDiagnostics.delete(path);
			this.diagnosticsWaiters.delete(path);
			return Promise.resolve();
		});
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
		const resolvedPath = this.resolveTargetPath(path);
		await this.ensureFileOpen(proc, resolvedPath);
		// Pull-model support may be declared statically (initialize's own diagnosticProvider) or
		// dynamically (a post-initialize client/registerCapability for textDocument/diagnostic --
		// Roslyn/C#, Kotlin register this way rather than statically). Either source, or both at
		// once, means: request fresh rather than waiting on push's own timing, and merge with
		// whatever push has already delivered (a server may run both models at once, or have pushed
		// before pull was even requested).
		const identifiers = this.diagnosticPullIdentifiers();
		if (identifiers.length > 0) {
			let pulled: Diagnostic[] = [];
			for (const identifier of identifiers) pulled = mergeDiagnostics(pulled, await this.pullDiagnostics(proc, resolvedPath, identifier));
			return mergeDiagnostics(this.latestDiagnostics.get(resolvedPath) ?? [], pulled);
		}
		if (!this.latestDiagnostics.has(resolvedPath)) await this.waitForDiagnosticsNotification(resolvedPath, 5000);
		return this.latestDiagnostics.get(resolvedPath) ?? [];
	}

	/**
	 * Every distinct pull channel to query for one diagnostics() call: the static diagnosticProvider's
	 * own identifier (if declared at all, even without one), plus one entry per dynamically-registered
	 * textDocument/diagnostic (each may carry its own distinct identifier when a server manages several
	 * diagnostic sources for the same document). Deduplicated by identifier value -- undefined counts as
	 * one bucket -- so a server that both statically declares an unlabeled provider and later registers
	 * the same unlabeled channel again dynamically is pulled once, not twice. An empty result means no
	 * pull support exists anywhere for this server; the caller falls back to the push-wait path.
	 */
	private diagnosticPullIdentifiers(): (string | undefined)[] {
		const identifiers = new Set<string | undefined>();
		if (this.negotiatedCapabilities?.diagnosticProvider) identifiers.add(this.negotiatedCapabilities.diagnosticProvider.identifier);
		for (const registration of this.dynamicCapabilities.diagnosticRegistrations) identifiers.add(registration.identifier);
		return [...identifiers];
	}

	/** Requests textDocument/diagnostic directly rather than waiting on the server's own push timing. Returns [] for an "unchanged" report -- Lector never sends previousResultId, so it has nothing cached under that resultId to fall back to besides what push already holds. */
	private async pullDiagnostics(proc: LanguageServerProcess, path: string, identifier?: string): Promise<Diagnostic[]> {
		const report = await proc.request<LspDocumentDiagnosticReport | null>("textDocument/diagnostic", {
			textDocument: { uri: pathToFileURL(path).href },
			...(identifier !== undefined ? { identifier } : {}),
		});
		if (report?.kind !== "full") return [];
		return report.items.map((item) => normalizeDiagnostic(path, item));
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

	async prepareRename(at: WorkspaceLocation): Promise<RenameRange | null> {
		const proc = await this.ensureInitialized(at.path);
		await this.ensureFileOpen(proc, at.path);
		try {
			const result = await proc.request<unknown>("textDocument/prepareRename", {
				textDocument: { uri: pathToFileURL(at.path).href },
				position: toLspPosition(at.line, at.character),
			});
			return parsePrepareRenameResult(result, at.path);
		} catch {
			// Per spec a server may reject with a JSON-RPC error instead of a null result when
			// nothing is renameable here (typescript-language-server does this) -- same outcome.
			return null;
		}
	}

	async rename(at: WorkspaceLocation, newName: string): Promise<ParsedWorkspaceEdit> {
		const proc = await this.ensureInitialized(at.path);
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<unknown>("textDocument/rename", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
			newName,
		});
		return parseWorkspaceEdit(result);
	}

	/**
	 * workspace/willRenameFiles participation for the RenameFile resource operations a rename's
	 * own WorkspaceEdit contains -- sent before applying anything, only when this server
	 * negotiated workspace.fileOperations.willRename. A response WorkspaceEdit the server may
	 * return is not merged in (a documented, narrower scope than full spec support) -- this call
	 * exists for multi-client cooperation/spec compliance, not to compute additional edits.
	 */
	async notifyFilesWillRename(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): Promise<void> {
		if (!this.negotiatedCapabilities?.workspaceFileOperations.willRename || pairs.length === 0) return;
		const proc = await this.ensureInitialized();
		await proc.request("workspace/willRenameFiles", {
			files: pairs.map((pair) => ({ oldUri: pathToFileURL(pair.fromPath).href, newUri: pathToFileURL(pair.toPath).href })),
		});
	}

	/** workspace/didRenameFiles participation -- sent only after the rename has actually committed, only when this server negotiated workspace.fileOperations.didRename. A notification, not a request: no response to wait for or act on. */
	notifyFilesDidRename(pairs: readonly { readonly fromPath: string; readonly toPath: string }[]): void {
		if (!this.negotiatedCapabilities?.workspaceFileOperations.didRename || pairs.length === 0 || !this.process) return;
		this.process.notify("workspace/didRenameFiles", {
			files: pairs.map((pair) => ({ oldUri: pathToFileURL(pair.fromPath).href, newUri: pathToFileURL(pair.toPath).href })),
		});
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
