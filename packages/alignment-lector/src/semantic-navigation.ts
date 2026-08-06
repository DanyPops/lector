import { isAbsolute, relative, resolve } from "node:path";
import {
	type ContributionCommand,
	type ContributionOutcome,
	type ContributionReadBounds,
	type ContributionResourceReference,
	ContributionResourceReferenceSchema,
} from "@alignment/surface-protocol";
import { remoteErrorIs } from "@danypops/lector";
import type { LectorOperations } from "./lector-operations.js";

const MAX_CACHED_RESOURCES = 128;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_ENTRIES = 10_000;

const SEMANTIC_COMMAND_BINDINGS = [
	{ id: "lector.search.text", title: "Search Text", operation: "workspace.searchText" },
	{ id: "lector.search.files", title: "Find Files", operation: "workspace.findFiles" },
	{ id: "lector.symbol.hover", title: "Show Hover", operation: "workspace.hover" },
	{ id: "lector.symbol.definition", title: "Go to Definition", operation: "workspace.goToDefinition" },
	{ id: "lector.symbol.references", title: "Find References", operation: "workspace.findReferences" },
	{ id: "lector.diagnostics.show", title: "Show Diagnostics", operation: "workspace.diagnostics" },
] as const;

export const SEMANTIC_COMMANDS = SEMANTIC_COMMAND_BINDINGS.map(({ id, title }) => ({ id, title }));

interface CachedSemanticResource {
	readonly reference: ContributionResourceReference;
	readonly value: Record<string, unknown>;
	readonly bytes: number;
	readonly entries: number;
}

export interface SemanticProvenance {
	readonly fidelity: "semantic" | "structural";
	readonly backend: string;
	readonly languageId: string;
	readonly authority: "language-server" | "parser" | "compiler";
	readonly freshness: "live-process" | "content-hash" | "filesystem-snapshot";
	readonly limitations: readonly string[];
}

export type SemanticStatus = "ready" | "degraded" | "stale";

/** Renderer-neutral cached result returned by the `lector:` resource provider. */
export interface SemanticResultProjection {
	readonly kind: "search-results" | "file-results" | "hover" | "locations" | "diagnostics";
	readonly status: SemanticStatus;
	readonly positionEncoding?: "utf-16";
	readonly provenance?: SemanticProvenance;
	readonly items?: readonly unknown[];
	readonly hover?: unknown;
	readonly truncated?: boolean;
}

function failure(code: string, message: string): ContributionOutcome<never> {
	return { ok: false, code, message };
}

function record(value: unknown): Record<string, unknown> | undefined {
	// This assertion follows the runtime object/null check and assigns no field meaning.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function provenance(value: unknown): SemanticProvenance | undefined {
	const parsed = record(value);
	if (
		!parsed ||
		(parsed.fidelity !== "semantic" && parsed.fidelity !== "structural") ||
		!nonEmptyString(parsed.backend) ||
		!nonEmptyString(parsed.languageId) ||
		(parsed.authority !== "language-server" && parsed.authority !== "parser" && parsed.authority !== "compiler") ||
		(parsed.freshness !== "live-process" && parsed.freshness !== "content-hash" && parsed.freshness !== "filesystem-snapshot") ||
		!Array.isArray(parsed.limitations) ||
		!parsed.limitations.every((entry) => typeof entry === "string")
	)
		return undefined;
	return {
		fidelity: parsed.fidelity,
		backend: parsed.backend,
		languageId: parsed.languageId,
		authority: parsed.authority,
		freshness: parsed.freshness,
		limitations: parsed.limitations,
	};
}

function semanticStatus(source: SemanticProvenance): SemanticStatus {
	if (source.fidelity === "structural") return "degraded";
	return source.freshness === "live-process" ? "ready" : "stale";
}

function signalFrom(input: Record<string, unknown>): AbortSignal | undefined {
	return input.signal instanceof AbortSignal ? input.signal : undefined;
}

async function callWithCancellation(operations: LectorOperations, operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
	if (!signal) return await operations.call(operation, input);
	// Vehicle RPC has no AbortSignal channel yet; stop the host wait and discard the bounded late result rather than caching it as if still requested.
	if (signal.aborted) throw new DOMException("Semantic request canceled", "AbortError");
	return await new Promise((resolve, reject) => {
		const canceled = () => reject(new DOMException("Semantic request canceled", "AbortError"));
		signal.addEventListener("abort", canceled, { once: true });
		void operations
			.call(operation, input)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", canceled));
	});
}

function isCanceled(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function isUnsupported(error: unknown): boolean {
	return ["UnsupportedLanguage", "NoSeedFileFound", "CodeIntelligenceUnavailable"].some((name) => remoteErrorIs(error, name));
}

function semanticReference(id: string, kind: string, title: string): ContributionResourceReference {
	return { uri: `lector://semantic/${id}`, kind, title, readOnly: true };
}

function semanticResourceId(value: ContributionResourceReference): string | undefined {
	const parsed = ContributionResourceReferenceSchema.safeParse(value);
	if (!parsed.success || parsed.data.readOnly !== true) return undefined;
	try {
		const uri = new URL(parsed.data.uri);
		const id = uri.pathname.slice(1);
		return uri.protocol === "lector:" && uri.hostname === "semantic" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export interface SemanticNavigationContribution {
	readonly commands: readonly ContributionCommand[];
	registerWorkspace(workspaceId: string, rootPath: string): void;
	read(resource: ContributionResourceReference, bounds: ContributionReadBounds): ContributionOutcome<unknown> | undefined;
	clear(): void;
}

export function createSemanticNavigationContribution(operations: LectorOperations): SemanticNavigationContribution {
	const resources = new Map<string, CachedSemanticResource>();
	const workspaceRoots = new Map<string, string>();
	let nextId = 1;

	function cache(kind: string, title: string, value: Record<string, unknown>, entries: number): ContributionOutcome<ContributionResourceReference> {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (entries > MAX_RESOURCE_ENTRIES || bytes > MAX_RESOURCE_BYTES)
			return failure("resource-bound-exceeded", `Semantic result exceeds the cache bound (${entries} entries, ${bytes} bytes)`);
		const id = String(nextId++);
		const reference = semanticReference(id, kind, title);
		resources.set(id, { reference, value, bytes, entries });
		while (resources.size > MAX_CACHED_RESOURCES) resources.delete(resources.keys().next().value ?? "");
		return { ok: true, value: reference };
	}

	function workspacePath(workspaceId: string, path: string): ContributionOutcome<{ absolute: string; project: string; root: string }> {
		const root = workspaceRoots.get(workspaceId);
		if (!root) return failure("workspace-not-open", "Workspace must be opened through this contribution before semantic navigation");
		if (isAbsolute(path)) return failure("invalid-input", "Semantic paths must remain workspace-relative");
		const absolute = resolve(root, path);
		const project = relative(root, absolute);
		if (project === ".." || project.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(project))
			return failure("invalid-input", "Semantic path escapes the workspace");
		return { ok: true, value: { absolute, project, root } };
	}

	function projectPath(root: string, path: unknown): string | undefined {
		if (!nonEmptyString(path)) return undefined;
		const projected = relative(root, isAbsolute(path) ? path : resolve(root, path));
		return projected === ".." || projected.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(projected) ? undefined : projected;
	}

	function projectLocations(root: string, value: unknown): Record<string, unknown>[] | undefined {
		if (!Array.isArray(value)) return undefined;
		const projected: Record<string, unknown>[] = [];
		for (const candidate of value) {
			const location = record(candidate);
			const path = projectPath(root, location?.path);
			if (!location || !path || !positiveInteger(location.line) || !positiveInteger(location.character)) return undefined;
			projected.push({ path, line: location.line, character: location.character });
		}
		return projected;
	}

	function projectRange(root: string, value: unknown): Record<string, unknown> | undefined {
		const range = record(value);
		const start = record(range?.start);
		const end = record(range?.end);
		const path = projectPath(root, range?.path);
		if (
			!range ||
			!path ||
			!start ||
			!end ||
			!positiveInteger(start.line) ||
			!positiveInteger(start.character) ||
			!positiveInteger(end.line) ||
			!positiveInteger(end.character)
		)
			return undefined;
		return { path, start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } };
	}

	async function execute(operation: string, input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		const parsed = record(input);
		if (!parsed) return failure("invalid-input", "Semantic command input must be an object");
		const signal = signalFrom(parsed);
		try {
			if (operation === "workspace.searchText") {
				if (
					!nonEmptyString(parsed.workspaceId) ||
					!nonEmptyString(parsed.query) ||
					!positiveInteger(parsed.maxMatches, 10_000) ||
					!positiveInteger(parsed.maxBytes, MAX_RESOURCE_BYTES)
				)
					return failure("invalid-input", "Text search requires workspaceId, query, and bounded maxMatches/maxBytes");
				const output = record(
					await callWithCancellation(
						operations,
						operation,
						{ workspaceId: parsed.workspaceId, query: parsed.query, maxMatches: parsed.maxMatches, maxBytes: parsed.maxBytes },
						signal,
					),
				);
				if (!output || !Array.isArray(output.matches) || typeof output.truncated !== "boolean")
					return failure("invalid-response", "Lector returned an invalid text-search result");
				return cache(
					"search-results",
					`Search: ${parsed.query}`,
					{ kind: "search-results", status: "ready", items: output.matches, truncated: output.truncated },
					output.matches.length,
				);
			}
			if (operation === "workspace.findFiles") {
				if (
					!nonEmptyString(parsed.workspaceId) ||
					!stringArray(parsed.patterns) ||
					!positiveInteger(parsed.maxResults, 10_000) ||
					!positiveInteger(parsed.maxBytes, MAX_RESOURCE_BYTES)
				)
					return failure("invalid-input", "File search requires workspaceId, patterns, and bounded maxResults/maxBytes");
				const output = record(
					await callWithCancellation(
						operations,
						operation,
						{ workspaceId: parsed.workspaceId, patterns: parsed.patterns, maxResults: parsed.maxResults, maxBytes: parsed.maxBytes },
						signal,
					),
				);
				if (!output || !Array.isArray(output.paths) || !output.paths.every((path) => typeof path === "string") || typeof output.truncated !== "boolean")
					return failure("invalid-response", "Lector returned an invalid file-search result");
				return cache("file-results", "Files", { kind: "file-results", status: "ready", items: output.paths, truncated: output.truncated }, output.paths.length);
			}

			if (!nonEmptyString(parsed.workspaceId) || !nonEmptyString(parsed.path))
				return failure("invalid-input", "Semantic navigation requires workspaceId and path");
			const resolved = workspacePath(parsed.workspaceId, parsed.path);
			if (!resolved.ok) return resolved;
			if (operation !== "workspace.diagnostics" && (!positiveInteger(parsed.line) || !positiveInteger(parsed.character)))
				return failure("invalid-input", "Symbol navigation requires 1-indexed line and character");
			const request: Record<string, unknown> = { workspaceId: parsed.workspaceId, path: resolved.value.absolute };
			if (operation !== "workspace.diagnostics") {
				request.line = parsed.line;
				request.character = parsed.character;
			}
			if (operation === "workspace.findReferences") request.includeDeclaration = parsed.includeDeclaration === true;
			const output = record(await callWithCancellation(operations, operation, request, signal));
			const source = provenance(output?.provenance);
			if (!output || !source) return failure("invalid-response", "Lector returned semantic data without valid provenance");
			const common = { status: semanticStatus(source), positionEncoding: "utf-16", provenance: source };
			if (operation === "workspace.hover") {
				const hover = output.hover === undefined ? undefined : record(output.hover);
				if (output.hover !== undefined && !hover) return failure("invalid-response", "Lector returned an invalid hover result");
				let projectedHover: Record<string, unknown> | null = hover ?? null;
				if (hover?.range !== undefined) {
					const range = projectRange(resolved.value.root, hover.range);
					if (!range) return failure("invalid-response", "Lector returned a hover range outside the workspace");
					projectedHover = { ...hover, range };
				}
				return cache("hover", `Hover: ${parsed.path}`, { kind: "hover", ...common, hover: projectedHover }, hover ? 1 : 0);
			}
			if (operation === "workspace.diagnostics") {
				if (!Array.isArray(output.diagnostics)) return failure("invalid-response", "Lector returned invalid diagnostics");
				const diagnostics: Record<string, unknown>[] = [];
				for (const candidate of output.diagnostics) {
					const diagnostic = record(candidate);
					const range = projectRange(resolved.value.root, diagnostic?.range);
					if (!diagnostic || !range) return failure("invalid-response", "Lector returned diagnostics outside the workspace");
					diagnostics.push({ ...diagnostic, range });
				}
				return cache("diagnostics", `Diagnostics: ${parsed.path}`, { kind: "diagnostics", ...common, items: diagnostics }, diagnostics.length);
			}
			const locations = projectLocations(resolved.value.root, output.locations);
			if (!locations) return failure("invalid-response", "Lector returned invalid locations");
			return cache(
				"locations",
				operation === "workspace.goToDefinition" ? "Definitions" : "References",
				{ kind: "locations", ...common, items: locations },
				locations.length,
			);
		} catch (error) {
			if (isCanceled(error)) return failure("canceled", "Semantic request was canceled");
			if (isUnsupported(error)) return failure("unsupported", error instanceof Error ? error.message : "Semantic operation is unsupported");
			return failure("lector-error", error instanceof Error ? error.message : "Lector semantic operation failed");
		}
	}

	const commands = SEMANTIC_COMMAND_BINDINGS.map(
		({ operation, ...description }): ContributionCommand => ({
			...description,
			execute: async (input) => await execute(operation, input),
		}),
	);

	return {
		commands,
		registerWorkspace(workspaceId, rootPath) {
			workspaceRoots.set(workspaceId, rootPath);
		},
		read(resource, bounds) {
			const id = semanticResourceId(resource);
			if (!id) return undefined;
			const cached = resources.get(id);
			if (!cached || cached.reference.uri !== resource.uri || cached.reference.kind !== resource.kind)
				return failure("resource-not-found", "Semantic result is unavailable or expired");
			if (cached.entries > bounds.maxEntries || cached.bytes > bounds.maxBytes)
				return failure("resource-bound-exceeded", `Semantic result has ${cached.entries} entries and ${cached.bytes} bytes`);
			return { ok: true, value: cached.value };
		},
		clear() {
			resources.clear();
			workspaceRoots.clear();
		},
	};
}
