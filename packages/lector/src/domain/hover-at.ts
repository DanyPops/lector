import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { Hover } from "./hover.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

/** Type/doc information for the symbol at a position. */
export async function hoverAt(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<Hover | undefined> {
	return index.hover(at);
}
