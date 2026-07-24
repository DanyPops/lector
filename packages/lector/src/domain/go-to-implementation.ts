import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

/** Every concrete implementation of the interface/abstract member at a position -- crosses a port boundary that goToDefinition cannot. */
export async function goToImplementation(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<WorkspaceLocation[]> {
	return index.goToImplementation(at);
}
