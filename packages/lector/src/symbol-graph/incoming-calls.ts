import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { IncomingCall } from "./call-hierarchy.ts";

/** Every real caller of the symbol at `at`, project-wide. */
export async function incomingCalls(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<IncomingCall[]> {
	return index.incomingCalls(at);
}
