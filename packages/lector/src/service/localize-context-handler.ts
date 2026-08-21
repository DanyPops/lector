import type { SymbolAnnotationPort } from "../symbol-annotation/port.ts";
import type { SymbolGraphPort } from "../symbol-graph/port.ts";
import type { TextSearchPort } from "../text-search/port.ts";
import { localizeContext } from "../workspace/localize-context.ts";
import { resolveBound } from "./bounds.ts";
import type { WorkspaceId } from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { type MutableRegistry, resolveWorkspace } from "./workspace-registry.ts";

const DEFAULT_CONTEXT_SYMBOLS = 20;
const MAX_CONTEXT_SYMBOLS = 500;
const DEFAULT_CONTEXT_BYTES = 30_000;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONTEXT_DEPTH = 2;
const MAX_CONTEXT_DEPTH = 5;
const DEFAULT_CONTEXT_DEADLINE_MS = 5_000;
const MAX_CONTEXT_DEADLINE_MS = 30_000;
const MAX_CONTEXT_QUERY_BYTES = 16 * 1024;
const MAX_CONTEXT_SEEDS = 100;

export function createLocalizeContextHandler(
	textSearch: TextSearchPort,
	graph: (workspaceId: WorkspaceId) => SymbolGraphPort,
	annotations: (workspaceId: WorkspaceId) => SymbolAnnotationPort,
) {
	return async (registry: MutableRegistry, input: OperationInputs["workspace.localizeContext"]): Promise<OperationOutputs["workspace.localizeContext"]> => {
		if (typeof input.query !== "string" || input.query.trim().length === 0) throw new TypeError("query must be a non-empty string");
		if (Buffer.byteLength(input.query, "utf8") > MAX_CONTEXT_QUERY_BYTES) {
			throw new TypeError(`query must be no greater than ${MAX_CONTEXT_QUERY_BYTES} UTF-8 bytes`);
		}
		if ((input.seedSymbols?.length ?? 0) > MAX_CONTEXT_SEEDS) throw new TypeError(`seedSymbols must contain no more than ${MAX_CONTEXT_SEEDS} entries`);
		if ((input.seedLocations?.length ?? 0) > MAX_CONTEXT_SEEDS) throw new TypeError(`seedLocations must contain no more than ${MAX_CONTEXT_SEEDS} entries`);
		for (const seed of input.seedLocations ?? []) {
			if (!Number.isSafeInteger(seed.line) || seed.line < 1) throw new TypeError("every seed location line must be a positive safe integer");
			if (seed.character !== undefined && (!Number.isSafeInteger(seed.character) || seed.character < 1)) {
				throw new TypeError("every seed location character must be a positive safe integer when provided");
			}
		}
		const maxSymbols = resolveBound(input.maxSymbols, DEFAULT_CONTEXT_SYMBOLS, MAX_CONTEXT_SYMBOLS, "maxSymbols");
		const maxBytes = resolveBound(input.maxBytes, DEFAULT_CONTEXT_BYTES, MAX_CONTEXT_BYTES, "maxBytes");
		const maxDepth = resolveBound(input.maxDepth, DEFAULT_CONTEXT_DEPTH, MAX_CONTEXT_DEPTH, "maxDepth");
		const deadlineMs = resolveBound(input.deadlineMs, DEFAULT_CONTEXT_DEADLINE_MS, MAX_CONTEXT_DEADLINE_MS, "deadlineMs");
		const workspace = resolveWorkspace(registry, input.workspaceId);
		return localizeContext(input.query, workspace, textSearch, graph(input.workspaceId), {
			maxSymbols,
			maxBytes,
			maxDepth,
			deadlineMs,
			maxGraphNodes: Math.min(20_000, Math.max(200, maxSymbols * 20)),
			maxLexicalMatches: Math.min(5_000, Math.max(100, maxSymbols * 10)),
			annotations: annotations(input.workspaceId),
			...(input.seedSymbols ? { seedSymbols: input.seedSymbols } : {}),
			...(input.seedLocations ? { seedLocations: input.seedLocations } : {}),
		});
	};
}
