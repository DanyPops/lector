export { contentHashOf, type ContentHash } from "./domain/content-hash.ts";
export { rawRead, WorkspaceEntryNotFound, type RawRead } from "./domain/raw-read.ts";
export {
	exactEdit,
	StaleExpectedHash,
	type EditOutcome,
	type ExpectedHashEdit,
} from "./domain/exact-edit.ts";
export type { MissingWorkspaceEntry, PresentWorkspaceEntry, WorkspaceEntry, WorkspacePort } from "./ports/workspace-port.ts";
export { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
