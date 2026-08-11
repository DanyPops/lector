import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { DocumentHighlight } from "./document-highlight.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Every other same-symbol occurrence within the single already-open document containing `at`, classified read/write/text. Undefined when the negotiated backend doesn't implement documentHighlights at all -- the caller decides whether that's an error (see DocumentHighlightsNotSupported) or a degrade-to-empty. */
export async function documentHighlights(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<DocumentHighlight[] | undefined> {
	if (!index.documentHighlights) return undefined;
	return index.documentHighlights(at);
}
