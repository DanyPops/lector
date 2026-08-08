/**
 * Registers workspace.gitStatus/gitLog/gitDiff onto a VehicleRegistry, delegating to the same
 * GitHandlers functions createLectorService's dispatch table uses (see dispatchThroughVehicle).
 * compareSymbolAcrossVersions and every other handler module stay off this registry.
 *
 * Each operation's own schema (git-schemas.ts) narrows its input, so a malformed value fails at
 * VehicleRegistry.invoke()'s parseInput step with a structured VehicleError("invalid-input", ...,
 * { details: { issues } }) before the handler runs.
 *
 * mapGitError (vehicle-core's defineErrorMapping) codes/categorizes the 3 domain errors
 * requireGitRepository can throw and sets `cause` to the original, so dispatchThroughVehicle's
 * unwrap keeps `instanceof NotAGitRepository` checks working for existing consumers while a
 * direct VehicleClient (or manifest()'s `errors` metadata) sees the real code.
 */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { NotAGitRepository, SymbolQueryUnavailable, UnknownWorkspace } from "../errors.ts";
import type { GitHandlers } from "../git-handlers.ts";
import type { MutableRegistry } from "../workspace-registry.ts";
import { gitDiffInputSchema, gitLogInputSchema, gitStatusInputSchema } from "./git-schemas.ts";
import { WORKSPACE_READ_PERMISSION } from "./permissions.ts";

const OWNER = "lector-git";

const READ_PERMISSIONS = [WORKSPACE_READ_PERMISSION];

/** Provisional bounds, not yet tuned per-operation against real usage -- a later, risk-prioritized pass. */
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 8 * 1024 * 1024 };

/** Every failure requireGitRepository (shared by all 3 operations) can actually throw, declared once. */
const GIT_REPOSITORY_ERRORS = [
	{ code: "unknown-workspace", description: "workspaceId names no workspace registered via workspace.registerPath" },
	{ code: "symbol-query-unavailable", description: "the workspace has no known root path (not registered from a real filesystem location)" },
	{ code: "not-a-git-repository", description: "the workspace's root is not inside a git repository" },
] as const;

/** Maps requireGitRepository's 3 real domain errors onto properly coded/categorized VehicleErrors, preserving the original as `cause`. */
const mapGitError = defineErrorMapping([
	{ errorClass: UnknownWorkspace, category: "not_found", code: "unknown-workspace" },
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAGitRepository, category: "validation", code: "not-a-git-repository" },
]);

/**
 * Registers workspace.gitStatus/gitLog/gitDiff onto `vehicleRegistry`, delegating to the exact
 * same GitHandlers functions createLectorService's real dispatch table uses -- this adds a real
 * Vehicle-backed entry point over identical business logic, it does not fork it.
 */
export function registerGitVehicleOperations(vehicleRegistry: VehicleRegistry, registry: MutableRegistry, handlers: GitHandlers): void {
	const gitStatus = defineVehicleOperation({
		name: "workspace.gitStatus",
		version: 1,
		description: "Reports a git workspace's current status (staged/unstaged/untracked files).",
		input: gitStatusInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GIT_REPOSITORY_ERRORS,
	});
	vehicleRegistry.register(
		OWNER,
		bindVehicleOperation(gitStatus, () => (context) => mapGitError(() => handlers["workspace.gitStatus"](registry, context.input))),
	);

	const gitLog = defineVehicleOperation({
		name: "workspace.gitLog",
		version: 1,
		description: "Lists a git workspace's recent commits, most recent first, bounded by maxCount.",
		input: gitLogInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GIT_REPOSITORY_ERRORS,
	});
	vehicleRegistry.register(
		OWNER,
		bindVehicleOperation(gitLog, () => (context) => mapGitError(() => handlers["workspace.gitLog"](registry, context.input))),
	);

	const gitDiff = defineVehicleOperation({
		name: "workspace.gitDiff",
		version: 1,
		description: "Shows a git workspace's current diff (ref omitted means the working tree), bounded by maxBytes.",
		input: gitDiffInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: GIT_REPOSITORY_ERRORS,
	});
	vehicleRegistry.register(
		OWNER,
		bindVehicleOperation(gitDiff, () => (context) => mapGitError(() => handlers["workspace.gitDiff"](registry, context.input))),
	);
}

export { READ_PERMISSIONS as GIT_READ_PERMISSIONS };
