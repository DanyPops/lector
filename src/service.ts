import { exactEdit, StaleExpectedHash, type EditOutcome, type ExpectedHashEdit } from "./domain/exact-edit.ts";
import { rawRead, WorkspaceEntryNotFound, type RawRead } from "./domain/raw-read.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";

/**
 * Identifies which registered workspace an operation targets. There is no
 * default/implicit workspace: an operation must always name one explicitly.
 * (Locus LCS-BUG-97/LCS-BUG-88 class -- an operation given no explicit
 * target must never fall back to "whatever was registered/used last".)
 */
export type WorkspaceId = string;

/** Raised when an operation names a workspaceId nothing was registered under. */
export class UnknownWorkspace extends Error {
	constructor(readonly workspaceId: WorkspaceId) {
		super(`no workspace registered under id "${workspaceId}"`);
		this.name = "UnknownWorkspace";
	}
}

export type OperationName = "workspace.rawRead" | "workspace.exactEdit";

export const OPERATION_NAMES: readonly OperationName[] = ["workspace.rawRead", "workspace.exactEdit"];

export interface OperationInputs {
	"workspace.rawRead": { workspaceId: WorkspaceId; path: string };
	"workspace.exactEdit": { workspaceId: WorkspaceId } & ExpectedHashEdit;
}

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
}

export interface LectorService {
	readonly operations: readonly OperationName[];
	dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
}

function resolveWorkspace(workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>, workspaceId: WorkspaceId): WorkspacePort {
	const workspace = workspaces.get(workspaceId);
	if (!workspace) throw new UnknownWorkspace(workspaceId);
	return workspace;
}

type OperationHandlers = {
	[Name in OperationName]: (
		workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>,
		input: OperationInputs[Name],
	) => Promise<OperationOutputs[Name]>;
};

const HANDLERS: OperationHandlers = {
	"workspace.rawRead": (workspaces, input) => rawRead(resolveWorkspace(workspaces, input.workspaceId), input.path),
	"workspace.exactEdit": (workspaces, input) => {
		const { workspaceId, ...edit } = input;
		return exactEdit(resolveWorkspace(workspaces, workspaceId), edit);
	},
};

/**
 * Create the Lector service over an explicit registry of workspaces.
 * Refuses to start with zero registered workspaces -- fails loudly at
 * construction (before the daemon ever binds a listener) rather than
 * starting and returning empty/error results per call later.
 * (Locus LCS-BUG-88 class.)
 */
export function createLectorService(workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>): LectorService {
	if (workspaces.size === 0) {
		throw new Error("Lector service requires at least one registered workspace; refusing to start with none");
	}

	return {
		operations: OPERATION_NAMES,
		// Declared `async` deliberately, not just typed `Promise<...>`: a handler (e.g.
		// resolveWorkspace's UnknownWorkspace) can throw synchronously, and only an `async`
		// function body converts a synchronous throw into a rejected promise automatically.
		// Without it, `dispatch` would sometimes throw and sometimes reject depending on
		// which operation ran -- a broken contract for any in-process caller (standalone
		// mode, a future Alef adapter) that isn't protected by the HTTP layer's try/catch.
		async dispatch<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
			const handler = HANDLERS[operation] as (
				workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>,
				input: OperationInputs[Name],
			) => Promise<OperationOutputs[Name]>;
			return handler(workspaces, input);
		},
	};
}

export { StaleExpectedHash, WorkspaceEntryNotFound };
