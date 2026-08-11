import { extname } from "node:path";
import type { WorkspacePort } from "../workspace/port.ts";
import type { DataFlowHint } from "./tree-sitter/data-flow-hints.ts";
import { findDataFlowHints } from "./tree-sitter/data-flow-hints.ts";

/** Reads `path` from `workspace` and runs findDataFlowHints against its current content -- an empty array, not an error, for a missing file or an extension with no registered grammar (findDataFlowHints's own contract). */
export async function dataFlowHintsForFile(workspace: WorkspacePort, path: string): Promise<DataFlowHint[]> {
	const entry = await workspace.readEntry(path);
	if (!entry.exists) return [];
	return findDataFlowHints(entry.content, extname(path));
}
