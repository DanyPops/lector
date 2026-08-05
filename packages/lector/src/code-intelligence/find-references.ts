import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Every project-wide usage of the symbol at a position. */
export async function findReferences(index: CodeIntelligencePort, at: WorkspaceLocation, includeDeclaration: boolean): Promise<WorkspaceLocation[]> {
	return index.findReferences(at, includeDeclaration);
}
