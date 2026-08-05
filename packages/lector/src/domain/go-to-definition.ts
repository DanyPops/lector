import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";

/** Where the symbol at a position is actually declared. */
export async function goToDefinition(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
	return index.goToDefinition(at);
}
