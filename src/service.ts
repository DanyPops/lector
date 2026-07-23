import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalFilesystemWorkspace } from "./adapters/local-filesystem-workspace.ts";
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

export type OperationName = "workspace.rawRead" | "workspace.exactEdit" | "workspace.registerPath";

export const OPERATION_NAMES: readonly OperationName[] = ["workspace.rawRead", "workspace.exactEdit", "workspace.registerPath"];

export interface OperationInputs {
	"workspace.rawRead": { workspaceId: WorkspaceId; path: string };
	"workspace.exactEdit": { workspaceId: WorkspaceId } & ExpectedHashEdit;
	"workspace.registerPath": { path: string };
}

export interface OperationOutputs {
	"workspace.rawRead": RawRead;
	"workspace.exactEdit": EditOutcome;
	"workspace.registerPath": { workspaceId: WorkspaceId; created: boolean };
}

/** Raised when workspace.registerPath is given a path that isn't a real, accessible directory. */
export class InvalidWorkspaceRoot extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(`cannot register "${path}" as a workspace root: ${reason}`);
		this.name = "InvalidWorkspaceRoot";
	}
}

/**
 * Deterministically derive a workspaceId from a resolved absolute path, so the same
 * directory always yields the same id -- across repeat calls AND across a daemon
 * restart, since nothing about this derivation depends on runtime/in-memory state.
 * A shorter digest than ContentHash's is deliberate: this identifies a workspace root
 * for addressing/logging, not a content value needing full collision resistance.
 */
function deriveWorkspaceId(absolutePath: string): WorkspaceId {
	return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
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

type MutableRegistry = Map<WorkspaceId, WorkspacePort>;

type OperationHandlers = {
	[Name in OperationName]: (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
};

async function registerPath(registry: MutableRegistry, input: OperationInputs["workspace.registerPath"]): Promise<OperationOutputs["workspace.registerPath"]> {
	const absolutePath = resolve(input.path);
	const workspaceId = deriveWorkspaceId(absolutePath);
	if (registry.has(workspaceId)) {
		return { workspaceId, created: false };
	}

	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(absolutePath);
	} catch {
		throw new InvalidWorkspaceRoot(absolutePath, "path does not exist or is not accessible");
	}
	if (!stats.isDirectory()) {
		throw new InvalidWorkspaceRoot(absolutePath, "path is not a directory");
	}

	registry.set(workspaceId, new LocalFilesystemWorkspace(absolutePath));
	return { workspaceId, created: true };
}

const HANDLERS: OperationHandlers = {
	"workspace.rawRead": (registry, input) => rawRead(resolveWorkspace(registry, input.workspaceId), input.path),
	"workspace.exactEdit": (registry, input) => {
		const { workspaceId, ...edit } = input;
		return exactEdit(resolveWorkspace(registry, workspaceId), edit);
	},
	"workspace.registerPath": registerPath,
};

/**
 * Create the Lector service over an explicit initial registry of workspaces.
 * Refuses to start with zero registered workspaces -- fails loudly at
 * construction (before the daemon ever binds a listener) rather than
 * starting and returning empty/error results per call later.
 * (Locus LCS-BUG-88 class.) The registry grows at runtime only through
 * workspace.registerPath; there is still no operation that guesses a target
 * from anything other than an explicit id or an explicit path.
 */
export function createLectorService(workspaces: ReadonlyMap<WorkspaceId, WorkspacePort>): LectorService {
	if (workspaces.size === 0) {
		throw new Error("Lector service requires at least one registered workspace; refusing to start with none");
	}
	const registry: MutableRegistry = new Map(workspaces);

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
				registry: MutableRegistry,
				input: OperationInputs[Name],
			) => Promise<OperationOutputs[Name]>;
			return handler(registry, input);
		},
	};
}

export { StaleExpectedHash, WorkspaceEntryNotFound };
