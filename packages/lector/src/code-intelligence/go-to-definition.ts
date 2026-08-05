import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Where the symbol at a position is actually declared. */
export async function goToDefinition(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
	return index.goToDefinition(at);
}
