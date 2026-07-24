import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

/** Every project-wide usage of the symbol at a position. */
export async function findReferences(index: CodeIntelligencePort, at: WorkspaceLocation, includeDeclaration: boolean): Promise<WorkspaceLocation[]> {
	return index.findReferences(at, includeDeclaration);
}
