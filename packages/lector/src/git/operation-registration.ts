/** Git operation contracts delegate to GitHandlers so every entry point shares one implementation and the same domain errors. */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { WORKSPACE_READ_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import { NotAGitRepository, SymbolQueryUnavailable } from "../service/errors.ts";
import type { GitHandlers } from "../service/git-handlers.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import { gitDiffInputSchema, gitLogInputSchema, gitStatusInputSchema } from "./input-schemas.ts";

const OWNER = "lector-git";

const READ_PERMISSIONS = [WORKSPACE_READ_PERMISSION];

/** Provisional bounds, not yet tuned per-operation against real usage -- a later, risk-prioritized pass. */
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 8 * 1024 * 1024 };

/** Every failure requireGitRepository (shared by all 3 operations) can actually throw, declared once. */
const GIT_REPOSITORY_ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	{ code: "symbol-query-unavailable", description: "the workspace has no known root path (not registered from a real filesystem location)" },
	{ code: "not-a-git-repository", description: "the workspace's root is not inside a git repository" },
];

/** Maps requireGitRepository's 3 real domain errors onto properly coded/categorized VehicleErrors, preserving the original as `cause`. */
const mapGitError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: SymbolQueryUnavailable, category: "unavailable", code: "symbol-query-unavailable" },
	{ errorClass: NotAGitRepository, category: "validation", code: "not-a-git-repository" },
]);

/** Registers the Git operation contracts without duplicating GitHandlers behavior. */
export function registerGitOperations(operationRegistry: VehicleRegistry, registry: MutableRegistry, handlers: GitHandlers): void {
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
	operationRegistry.register(
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
	operationRegistry.register(
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
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(gitDiff, () => (context) => mapGitError(() => handlers["workspace.gitDiff"](registry, context.input))),
	);
}

export { READ_PERMISSIONS as GIT_READ_PERMISSIONS };
