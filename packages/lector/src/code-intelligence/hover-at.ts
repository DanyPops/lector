import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { Hover } from "./hover.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Type/doc information for the symbol at a position. */
export async function hoverAt(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<Hover | undefined> {
	return index.hover(at);
}
