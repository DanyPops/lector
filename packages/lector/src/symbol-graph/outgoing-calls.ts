import type { CodeIntelligencePort } from "../code-intelligence/port.ts";
import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { OutgoingCall } from "./call-hierarchy.ts";

/** Every function/method the symbol at `at` itself calls. */
export async function outgoingCalls(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<OutgoingCall[]> {
	return index.outgoingCalls(at);
}
