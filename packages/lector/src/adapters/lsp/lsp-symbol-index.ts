import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CallHierarchyEntry, IncomingCall, OutgoingCall } from "../../domain/call-hierarchy.ts";
import type { CodeRange } from "../../domain/code-range.ts";
import type { Diagnostic, DiagnosticSeverity } from "../../domain/diagnostic.ts";
import type { DocumentSymbolEntry } from "../../domain/document-symbol.ts";
import type { Hover } from "../../domain/hover.ts";
import { DEFAULT_SETTLE_MS, type LanguageServerDescriptor } from "../../domain/language-server-descriptor.ts";
import type { WorkspaceLocation, WorkspaceSymbol } from "../../domain/workspace-symbol.ts";
import type { CodeIntelligencePort } from "../../ports/code-intelligence-port.ts";
import type { SymbolIndexPort } from "../../ports/symbol-index-port.ts";
import { discoverSeedFile } from "./discover-seed-file.ts";
import { LanguageServerProcess } from "./language-server-process.ts";

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
		return { command: "bun", args: [fileURLToPath(import.meta.resolve(descriptor.launch.entryModule)), ...descriptor.args] };
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
	private readonly cwd: string;
	private readonly descriptor: LanguageServerDescriptor;
	private readonly explicitSeedFile: string | undefined;
	private readonly openedFiles = new Set<string>();
	private readonly latestDiagnostics = new Map<string, Diagnostic[]>();
	private readonly diagnosticsWaiters = new Map<string, Array<() => void>>();
	private process: LanguageServerProcess | undefined;
	private initializing: Promise<LanguageServerProcess> | undefined;

	constructor(cwd: string, descriptor: LanguageServerDescriptor, seedFile?: string) {
		this.cwd = cwd;
		this.descriptor = descriptor;
		this.explicitSeedFile = seedFile;
	}

	/** Undefined before the server process has been spawned (first real query). */
	get processId(): number | undefined {
		return this.process?.pid;
	}

	private async ensureInitialized(): Promise<LanguageServerProcess> {
		if (this.process) return this.process;
		if (!this.initializing) {
			this.initializing = (async () => {
				const proc = LanguageServerProcess.spawnProcess({
					...resolveLanguageServerCommand(this.descriptor),
					cwd: this.cwd,
				});
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

				const seedFile = this.explicitSeedFile ?? discoverSeedFile(this.cwd, this.descriptor.extensions, this.descriptor.commonSeedCandidates);
				const seedPath = join(this.cwd, seedFile);
				proc.notify("textDocument/didOpen", {
					textDocument: {
						uri: pathToFileURL(seedPath).href,
						languageId: this.descriptor.languageId,
						version: 1,
						text: readFileSync(seedPath, "utf-8"),
					},
				});
				this.openedFiles.add(seedPath);
				// No server signals "project loaded"; must match ensureFileOpen's wait below,
				// since the seed file is often the first file a caller queries.
				await new Promise((resolve) => setTimeout(resolve, this.descriptor.settleMs ?? DEFAULT_SETTLE_MS));

				this.process = proc;
				return proc;
			})().catch((error: unknown) => {
				// A failed initialize must not permanently poison this workspace's index --
				// the next call retries fresh rather than replaying the same rejection forever.
				this.initializing = undefined;
				throw error;
			});
		}
		return this.initializing;
	}

	/** Opens `path` with the server if not already open, then waits for it to settle. A no-op past the first call for a given path. */
	private async ensureFileOpen(proc: LanguageServerProcess, path: string): Promise<void> {
		if (this.openedFiles.has(path)) return;
		proc.notify("textDocument/didOpen", {
			textDocument: { uri: pathToFileURL(path).href, languageId: this.descriptor.languageId, version: 1, text: readFileSync(path, "utf-8") },
		});
		this.openedFiles.add(path);
		await new Promise((resolve) => setTimeout(resolve, this.descriptor.settleMs ?? DEFAULT_SETTLE_MS));
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

	async findSymbols(query: string): Promise<WorkspaceSymbol[]> {
		const proc = await this.ensureInitialized();
		const results = (await proc.request<LspSymbolInformation[] | null>("workspace/symbol", { query })) ?? [];
		return results.map((symbol) => ({
			name: symbol.name,
			kind: LSP_SYMBOL_KIND_NAMES[symbol.kind] ?? "unknown",
			location: {
				path: fileURLToPath(symbol.location.uri),
				line: symbol.location.range.start.line + 1,
				character: symbol.location.range.start.character + 1,
			},
			containerName: symbol.containerName,
		}));
	}

	async goToDefinition(at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
		const proc = await this.ensureInitialized();
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<LspLocation | LspLocation[] | LspLocationLink[] | null>("textDocument/definition", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		return normalizeLocations(result);
	}

	async findReferences(at: WorkspaceLocation, includeDeclaration: boolean): Promise<WorkspaceLocation[]> {
		const proc = await this.ensureInitialized();
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
		const proc = await this.ensureInitialized();
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<LspHover | null>("textDocument/hover", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		if (!result) return undefined;
		return { contents: normalizeHoverContents(result.contents), range: result.range ? toCodeRange(at.path, result.range) : undefined };
	}

	async documentSymbols(path: string): Promise<DocumentSymbolEntry[]> {
		const proc = await this.ensureInitialized();
		await this.ensureFileOpen(proc, path);
		const results =
			(await proc.request<(LspDocumentSymbol | LspSymbolInformation)[] | null>("textDocument/documentSymbol", {
				textDocument: { uri: pathToFileURL(path).href },
			})) ?? [];
		return results.map((item) => normalizeDocumentSymbol(path, item));
	}

	async diagnostics(path: string): Promise<Diagnostic[]> {
		const proc = await this.ensureInitialized();
		await this.ensureFileOpen(proc, path);
		if (!this.latestDiagnostics.has(path)) await this.waitForDiagnosticsNotification(path, 5000);
		return this.latestDiagnostics.get(path) ?? [];
	}

	/** Raw LSP items, `data` intact -- callHierarchy/incomingCalls|outgoingCalls need the exact item prepareCallHierarchy returned, not a normalized copy. */
	private async prepareCallHierarchyRaw(proc: LanguageServerProcess, at: WorkspaceLocation): Promise<LspCallHierarchyItem[]> {
		await this.ensureFileOpen(proc, at.path);
		const result = await proc.request<LspCallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", {
			textDocument: { uri: pathToFileURL(at.path).href },
			position: toLspPosition(at.line, at.character),
		});
		return result ?? [];
	}

	async prepareCallHierarchy(at: WorkspaceLocation): Promise<CallHierarchyEntry[]> {
		const proc = await this.ensureInitialized();
		const items = await this.prepareCallHierarchyRaw(proc, at);
		return items.map((item) => normalizeCallHierarchyItem(item));
	}

	async incomingCalls(at: WorkspaceLocation): Promise<IncomingCall[]> {
		const proc = await this.ensureInitialized();
		const root = (await this.prepareCallHierarchyRaw(proc, at))[0];
		if (!root) return [];
		const results = (await proc.request<LspCallHierarchyIncomingCall[] | null>("callHierarchy/incomingCalls", { item: root })) ?? [];
		return results.map((result) => ({
			from: normalizeCallHierarchyItem(result.from),
			fromRanges: result.fromRanges.map((range) => toCodeRange(fileURLToPath(result.from.uri), range)),
		}));
	}

	async outgoingCalls(at: WorkspaceLocation): Promise<OutgoingCall[]> {
		const proc = await this.ensureInitialized();
		const root = (await this.prepareCallHierarchyRaw(proc, at))[0];
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
		await this.process?.stop();
		this.process = undefined;
		this.initializing = undefined;
		this.openedFiles.clear();
		this.latestDiagnostics.clear();
		this.diagnosticsWaiters.clear();
	}
}
