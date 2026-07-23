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
export { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "./adapters/local-filesystem-workspace.ts";
export {
	createLectorService,
	InvalidWorkspaceRoot,
	OPERATION_NAMES,
	UnknownWorkspace,
	type LectorService,
	type OperationInputs,
	type OperationName,
	type OperationOutputs,
	type WorkspaceId,
} from "./service.ts";
export { buildLectorApp, serveMain, startLectorDaemon, type LectorDaemonOptions } from "./daemon.ts";
export { connectLectorClient, remoteErrorIs, type ConnectLectorClientOptions, type LectorClient } from "./client.ts";
export { lectorVersion } from "./version.ts";
