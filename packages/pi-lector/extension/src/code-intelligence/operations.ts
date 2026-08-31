import type { JobSnapshot, OperationInputs, OperationOutputs, PopulateSymbolGraphResult, SymbolEdgeKind, SymbolNode } from "@danypops/lector";
import { lectorClient, withWorkspace, workspaceForCodeIntelligencePath, workspaceForPathOrDirectory } from "../lector-client.ts";
import { invokeLectorVehicleOperation, type LectorVehicleCall } from "../vehicle-client.ts";

const CODE_ACTION_PREVIEW_PERMISSIONS = ["workspace:read"];
const CODE_ACTION_APPLY_PERMISSIONS = ["workspace:write"];

/**
 * Thin wrappers over Lector's code-intelligence operations: goToDefinition,
 * findReferences, hover, documentSymbols. Position-based (path + 1-indexed
 * line + character), not symbol-name-based:
 * an agent already has an exact position from a prior read or find_symbols
 * call, so these compose directly off that rather than requiring a second,
 * ambiguity-prone "which occurrence of this name" lookup.
 *
 * `path` resolves its own workspace per call (workspaceForCodeIntelligencePath,
 * falling back to the file's own containing directory, never the filesystem
 * root -- every one of these operations spawns a real language server,
 * unlike read/write/edit) -- never a value captured once at session start.
 *
 * Exception: populateSymbolGraph, workspaceMap, and hasWarmIndex are not file-anchored --
 * their `path` genuinely means "the project itself", so they resolve via
 * workspaceForPathOrDirectory instead, which does not blindly take dirname() first. A real,
 * confirmed live bug: passing a project's own root directory through workspaceForCodeIntelligencePath
 * silently resolved to that directory's *parent* (dirname strips the final segment even when the
 * given path was already a directory with its own .git), mixing in every sibling project's graph.
 */
export interface CodeIntelligenceOperations {
	goToDefinition(path: string, line: number, character: number): Promise<OperationOutputs["workspace.goToDefinition"]>;
	goToImplementation(path: string, line: number, character: number): Promise<OperationOutputs["workspace.goToImplementation"]>;
	findReferences(
		path: string,
		line: number,
		character: number,
		includeDeclaration: boolean,
		responseFormat?: OperationInputs["workspace.findReferences"]["responseFormat"],
	): Promise<OperationOutputs["workspace.findReferences"]>;
	hover(path: string, line: number, character: number): Promise<OperationOutputs["workspace.hover"]>;
	documentSymbols(path: string): Promise<OperationOutputs["workspace.documentSymbols"]>;
	diagnostics(path: string): Promise<OperationOutputs["workspace.diagnostics"]>;
	previewCodeActions(
		path: string,
		input: Omit<OperationInputs["workspace.previewCodeActions"], "workspaceId" | "path">,
		call: LectorVehicleCall,
	): Promise<OperationOutputs["workspace.previewCodeActions"]>;
	applyCodeAction(
		path: string,
		previewId: OperationInputs["workspace.applyCodeAction"]["previewId"],
		call: LectorVehicleCall,
	): Promise<OperationOutputs["workspace.applyCodeAction"]>;
	diagnosticDelta(
		path: string,
		source: OperationInputs["workspace.diagnosticDelta"]["source"],
		bounds?: Omit<OperationInputs["workspace.diagnosticDelta"], "workspaceId" | "source">,
	): Promise<OperationOutputs["workspace.diagnosticDelta"]>;
	prepareCallHierarchy(path: string, line: number, character: number): Promise<OperationOutputs["workspace.prepareCallHierarchy"]>;
	incomingCalls(path: string, line: number, character: number): Promise<OperationOutputs["workspace.incomingCalls"]>;
	outgoingCalls(path: string, line: number, character: number): Promise<OperationOutputs["workspace.outgoingCalls"]>;
	prepareTypeHierarchy(
		path: string,
		line: number,
		character: number,
		bounds?: Pick<OperationInputs["workspace.prepareTypeHierarchy"], "maxResults" | "maxBytes" | "deadlineMs">,
	): Promise<OperationOutputs["workspace.prepareTypeHierarchy"]>;
	supertypes(
		path: string,
		line: number,
		character: number,
		bounds?: Pick<OperationInputs["workspace.supertypes"], "maxResults" | "maxBytes" | "deadlineMs">,
	): Promise<OperationOutputs["workspace.supertypes"]>;
	subtypes(
		path: string,
		line: number,
		character: number,
		bounds?: Pick<OperationInputs["workspace.subtypes"], "maxResults" | "maxBytes" | "deadlineMs">,
	): Promise<OperationOutputs["workspace.subtypes"]>;
	impactAnalysis(
		path: string,
		source: OperationInputs["workspace.impactAnalysis"]["source"],
		bounds: Pick<
			OperationInputs["workspace.impactAnalysis"],
			"maxDepth" | "maxNodes" | "maxEdges" | "maxBytes" | "deadlineMs" | "coverage" | "autoPopulate" | "maxFiles" | "maxSymbolsPerFile"
		>,
	): Promise<OperationOutputs["workspace.impactAnalysis"]>;
	/**
	 * Not exposed as a standalone Pi tool -- every workspace auto-populates on first touch via
	 * monitorWorkspaceCache (workspace-cache/operations.ts). Kept here as an internal capability
	 * for tests that need a populated graph. For an explicit/custom-bound population outside
	 * Pi entirely, `lector workspace populate-symbol-graph` calls the daemon directly.
	 */
	populateSymbolGraph(path: string, maxFiles: number, maxSymbolsPerFile: number, waitMs?: number): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	/** Not exposed as a standalone Pi tool -- see populateSymbolGraph. */
	jobStatus(jobId: string): Promise<JobSnapshot<PopulateSymbolGraphResult>>;
	reachableFrom(
		path: string,
		line: number,
		character: number,
		maxDepth: number,
		kind?: SymbolEdgeKind,
		autoPopulation?: Pick<OperationInputs["workspace.reachableFrom"], "autoPopulate" | "maxFiles" | "maxSymbolsPerFile">,
	): Promise<readonly SymbolNode[]>;
	/** Never spawns a symbol index -- safe to call opportunistically (e.g. before deciding whether to enrich a result). */
	hasWarmIndex(path: string): Promise<boolean>;
	workspaceMap(path: string, maxNodes: number, maxEdges: number, maxEntries: number, maxBytes: number): Promise<OperationOutputs["workspace.map"]>;
	localizeContext(
		path: string,
		query: string,
		options?: {
			seedSymbols?: readonly string[];
			seedLocations?: readonly { path: string; line: number; character?: number }[];
			maxSymbols?: number;
			maxBytes?: number;
			maxDepth?: number;
			deadlineMs?: number;
		},
	): Promise<OperationOutputs["workspace.localizeContext"]>;
}

export function createLectorCodeIntelligenceOperations(ownerId?: string): CodeIntelligenceOperations {
	return {
		async goToDefinition(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.goToDefinition", { workspaceId, path, line, character });
				},
			);
		},
		async goToImplementation(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.goToImplementation", { workspaceId, path, line, character });
				},
			);
		},
		async findReferences(path, line, character, includeDeclaration, responseFormat) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.findReferences", { workspaceId, path, line, character, includeDeclaration, responseFormat });
				},
			);
		},
		async hover(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.hover", { workspaceId, path, line, character });
				},
			);
		},
		async documentSymbols(path) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.documentSymbols", { workspaceId, path });
				},
			);
		},
		async diagnostics(path) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.diagnostics", { workspaceId, path });
				},
			);
		},
		async previewCodeActions(path, input, call) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				({ workspaceId }) =>
					invokeLectorVehicleOperation<OperationOutputs["workspace.previewCodeActions"]>(
						"workspace.previewCodeActions",
						{ workspaceId, path, ...input },
						CODE_ACTION_PREVIEW_PERMISSIONS,
						call,
					),
			);
		},
		async applyCodeAction(path, previewId, call) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				({ workspaceId }) =>
					invokeLectorVehicleOperation<OperationOutputs["workspace.applyCodeAction"]>(
						"workspace.applyCodeAction",
						{ workspaceId, previewId },
						CODE_ACTION_APPLY_PERMISSIONS,
						call,
					),
			);
		},
		async diagnosticDelta(path, source, bounds) {
			return withWorkspace(
				() => workspaceForPathOrDirectory(path),
				async ({ workspaceId }) => (await lectorClient()).call("workspace.diagnosticDelta", { workspaceId, source, ...bounds }),
			);
		},
		async prepareCallHierarchy(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.prepareCallHierarchy", { workspaceId, path, line, character });
				},
			);
		},
		async incomingCalls(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.incomingCalls", { workspaceId, path, line, character });
				},
			);
		},
		async outgoingCalls(path, line, character) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.outgoingCalls", { workspaceId, path, line, character });
				},
			);
		},
		async prepareTypeHierarchy(path, line, character, bounds) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => (await lectorClient()).call("workspace.prepareTypeHierarchy", { workspaceId, path, line, character, ...bounds }),
			);
		},
		async supertypes(path, line, character, bounds) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => (await lectorClient()).call("workspace.supertypes", { workspaceId, path, line, character, ...bounds }),
			);
		},
		async subtypes(path, line, character, bounds) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => (await lectorClient()).call("workspace.subtypes", { workspaceId, path, line, character, ...bounds }),
			);
		},
		async impactAnalysis(path, source, bounds) {
			return withWorkspace(
				() => workspaceForPathOrDirectory(path),
				async ({ workspaceId }) => (await lectorClient()).call("workspace.impactAnalysis", { workspaceId, source, ...bounds }),
			);
		},
		async populateSymbolGraph(path, maxFiles, maxSymbolsPerFile, waitMs = 500) {
			return withWorkspace(
				() => workspaceForPathOrDirectory(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { job } = await client.callOnce("job.submit", {
						operation: "workspace.populateSymbolGraph",
						input: { workspaceId, maxFiles, maxSymbolsPerFile },
						waitMs,
						...(ownerId ? { ownerId } : {}),
					});
					return job;
				},
			);
		},
		async jobStatus(jobId) {
			const client = await lectorClient();
			const { job } = await client.call("job.status", { jobId });
			return job;
		},
		async reachableFrom(path, line, character, maxDepth, kind, autoPopulation) {
			return withWorkspace(
				() => workspaceForCodeIntelligencePath(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { symbols } = await client.call("workspace.reachableFrom", { workspaceId, path, line, character, maxDepth, kind, ...autoPopulation });
					return symbols;
				},
			);
		},
		async hasWarmIndex(path) {
			return withWorkspace(
				() => workspaceForPathOrDirectory(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					const { warm } = await client.call("workspace.hasWarmIndex", { workspaceId });
					return warm;
				},
			);
		},
		async workspaceMap(path, maxNodes, maxEdges, maxEntries, maxBytes) {
			return withWorkspace(
				() => workspaceForPathOrDirectory(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.map", { workspaceId, maxNodes, maxEdges, maxEntries, maxBytes });
				},
			);
		},
		async localizeContext(path, query, options = {}) {
			return withWorkspace(
				() => workspaceForPathOrDirectory(path),
				async ({ workspaceId }) => {
					const client = await lectorClient();
					return client.call("workspace.localizeContext", { workspaceId, query, ...options });
				},
			);
		},
	};
}
