import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { OutgoingCall } from "./call-hierarchy.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

/** Every function/method the symbol at `at` itself calls. */
export async function outgoingCalls(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<OutgoingCall[]> {
	return index.outgoingCalls(at);
}
