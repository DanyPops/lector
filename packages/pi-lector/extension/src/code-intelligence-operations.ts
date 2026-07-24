import type {
	CallHierarchyEntry,
	Diagnostic,
	DocumentSymbolEntry,
	Hover,
	IncomingCall,
	OutgoingCall,
	SymbolEdgeKind,
	SymbolNode,
	WorkspaceLocation,
} from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForPath } from "./lector-client.ts";

/**
 * Thin wrappers over Lector's code-intelligence operations: goToDefinition,
 * findReferences, hover, documentSymbols. Position-based (path + 1-indexed
 * line + character), not symbol-name-based:
 * an agent already has an exact position from a prior read or find_symbols
 * call, so these compose directly off that rather than requiring a second,
 * ambiguity-prone "which occurrence of this name" lookup.
 *
 * `path` resolves its own workspace per call (workspaceForPath, falling back
 * to the filesystem root when no enclosing git repo exists) -- the same
 * per-call resolution read/write/edit/find_symbols already use, never a
 * value captured once at session start.
 */
export interface CodeIntelligenceOperations {
	goToDefinition(path: string, line: number, character: number): Promise<readonly WorkspaceLocation[]>;
	goToImplementation(path: string, line: number, character: number): Promise<readonly WorkspaceLocation[]>;
	findReferences(path: string, line: number, character: number, includeDeclaration: boolean): Promise<readonly WorkspaceLocation[]>;
	hover(path: string, line: number, character: number): Promise<Hover | undefined>;
	documentSymbols(path: string): Promise<readonly DocumentSymbolEntry[]>;
	diagnostics(path: string): Promise<readonly Diagnostic[]>;
	prepareCallHierarchy(path: string, line: number, character: number): Promise<readonly CallHierarchyEntry[]>;
	incomingCalls(path: string, line: number, character: number): Promise<readonly IncomingCall[]>;
	outgoingCalls(path: string, line: number, character: number): Promise<readonly OutgoingCall[]>;
	populateSymbolGraph(
		path: string,
		maxFiles: number,
		maxSymbolsPerFile: number,
	): Promise<{ filesProcessed: number; symbolsProcessed: number; nodesAdded: number; edgesAdded: number }>;
	reachableFrom(path: string, line: number, character: number, maxDepth: number, kind?: SymbolEdgeKind): Promise<readonly SymbolNode[]>;
	/** Never spawns a symbol index -- safe to call opportunistically (e.g. before deciding whether to enrich a result). */
	hasWarmIndex(path: string): Promise<boolean>;
}

export function createLectorCodeIntelligenceOperations(): CodeIntelligenceOperations {
	return {
		async goToDefinition(path, line, character) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { locations } = await client.call("workspace.goToDefinition", { workspaceId, path, line, character });
					return locations;
				},
			);
		},
		async goToImplementation(path, line, character) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { locations } = await client.call("workspace.goToImplementation", { workspaceId, path, line, character });
					return locations;
				},
			);
		},
		async findReferences(path, line, character, includeDeclaration) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { locations } = await client.call("workspace.findReferences", { workspaceId, path, line, character, includeDeclaration });
					return locations;
				},
			);
		},
		async hover(path, line, character) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { hover } = await client.call("workspace.hover", { workspaceId, path, line, character });
					return hover;
				},
			);
		},
		async documentSymbols(path) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { symbols } = await client.call("workspace.documentSymbols", { workspaceId, path });
					return symbols;
				},
			);
		},
		async diagnostics(path) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { diagnostics } = await client.call("workspace.diagnostics", { workspaceId, path });
					return diagnostics;
				},
			);
		},
		async prepareCallHierarchy(path, line, character) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { items } = await client.call("workspace.prepareCallHierarchy", { workspaceId, path, line, character });
					return items;
				},
			);
		},
		async incomingCalls(path, line, character) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { calls } = await client.call("workspace.incomingCalls", { workspaceId, path, line, character });
					return calls;
				},
			);
		},
		async outgoingCalls(path, line, character) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { calls } = await client.call("workspace.outgoingCalls", { workspaceId, path, line, character });
					return calls;
				},
			);
		},
		async populateSymbolGraph(path, maxFiles, maxSymbolsPerFile) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.populateSymbolGraph", { workspaceId, maxFiles, maxSymbolsPerFile });
				},
			);
		},
		async reachableFrom(path, line, character, maxDepth, kind) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { symbols } = await client.call("workspace.reachableFrom", { workspaceId, path, line, character, maxDepth, kind });
					return symbols;
				},
			);
		},
		async hasWarmIndex(path) {
			return withWorkspace(
				() => workspaceForPath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { warm } = await client.call("workspace.hasWarmIndex", { workspaceId });
					return warm;
				},
			);
		},
	};
}
