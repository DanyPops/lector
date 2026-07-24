import type { CallHierarchyEntry } from "./call-hierarchy.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";
import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";

/** The call-hierarchy root(s) the symbol at `at` resolves to -- usually zero or one. */
export async function prepareCallHierarchy(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<CallHierarchyEntry[]> {
	return index.prepareCallHierarchy(at);
}
