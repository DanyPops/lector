import type { WorkspacePort } from "./port.ts";

export type SourceSnapshot =
	| { readonly status: "ready"; readonly content: string }
	| { readonly status: "unavailable"; readonly reason: "missing" | "unreadable" | "limit" | "aborted" };

/** Reads source within byte and cancellation bounds for live code queries. */
export interface SourceSnapshotPort {
	readSourceSnapshot(path: string, maxBytes: number, signal: AbortSignal): Promise<SourceSnapshot>;
}

/** Detects whether a workspace supports bounded source inspection. */
export function supportsSourceSnapshot(workspace: WorkspacePort): workspace is WorkspacePort & SourceSnapshotPort {
	return "readSourceSnapshot" in workspace && typeof workspace.readSourceSnapshot === "function";
}
