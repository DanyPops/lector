import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Every concrete implementation of the interface/abstract member at a position -- crosses a port boundary that goToDefinition cannot. */
export async function goToImplementation(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
	return index.goToImplementation(at);
}
