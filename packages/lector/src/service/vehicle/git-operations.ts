/**
 * Vehicle migration Phase 1 pilot -- proves the mechanics/cost of wrapping an existing,
 * already-extracted handler module (GitHandlers) in defineVehicleOperation/bindVehicleOperation
 * and registering it onto a real VehicleRegistry, WITHOUT touching createLectorService's real
 * dispatch table (that swap is Phase 2). Deliberately scoped to the 3 smallest git operations
 * (gitStatus/gitLog/gitDiff) -- compareSymbolAcrossVersions and every other handler module stay
 * untouched here.
 *
 * Real friction found and documented (see the epic task for the full writeup):
 * - No schema exists yet for Lector's typed OperationInputs/OperationOutputs; defineLooseObjectSchema
 *   only validates flat scalar properties, so the caller-side extraction below (requireWorkspaceId
 *   etc.) does the narrowing defineLooseObjectSchema's own Record<string, unknown> output can't.
 * - VehicleRegistry.invoke() wraps any non-VehicleError thrown by a handler into a generic
 *   VehicleError("handler-failed", ...) -- the original typed error (NotAGitRepository,
 *   UnknownWorkspace, ...) is preserved only via the standard Error.cause chain, not as the
 *   thrown value's own type. Every one of Lector's 23+ domain error classes existing consumers
 *   check via `instanceof` would lose that identity at the Vehicle boundary unless mapped to a
 *   real VehicleFailureDescriptor -- a real Phase 3 design decision, not a mechanical port.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { GitHandlers } from "../git-handlers.ts";
import type { MutableRegistry } from "../workspace-registry.ts";

const OWNER = "lector-git-pilot";

/** Provisional -- Lector has no real permission taxonomy yet (Phase 3). Every git query is read-only. */
const READ_PERMISSIONS = ["workspace:read"];

/** Provisional bounds, not yet tuned per-operation against real usage (Phase 3). */
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 8 * 1024 * 1024 };

function requireWorkspaceId(input: Record<string, unknown>): string {
	const { workspaceId } = input;
	if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new TypeError("workspaceId must be a non-empty string");
	return workspaceId;
}

function requireMaxCount(input: Record<string, unknown>): number {
	const { maxCount } = input;
	if (typeof maxCount !== "number" || !Number.isSafeInteger(maxCount) || maxCount < 1) {
		throw new TypeError("maxCount must be a positive safe integer");
	}
	return maxCount;
}

function requireMaxBytes(input: Record<string, unknown>): number {
	const { maxBytes } = input;
	if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new TypeError("maxBytes must be a positive safe integer");
	}
	return maxBytes;
}

function optionalRef(input: Record<string, unknown>): string | undefined {
	const { ref } = input;
	if (ref === undefined) return undefined;
	if (typeof ref !== "string") throw new TypeError("ref must be a string when given");
	return ref;
}

/**
 * Registers workspace.gitStatus/gitLog/gitDiff onto `vehicleRegistry`, delegating to the exact
 * same GitHandlers functions createLectorService's real dispatch table already uses -- this pilot
 * adds a second, parallel entry point over identical business logic, it does not fork it.
 */
export function registerGitVehicleOperationsPilot(vehicleRegistry: VehicleRegistry, registry: MutableRegistry, handlers: GitHandlers): void {
	const gitStatus = defineVehicleOperation({
		name: "workspace.gitStatus",
		version: 1,
		description: "Reports a git workspace's current status (staged/unstaged/untracked files).",
		input: defineLooseObjectSchema({ workspaceId: { type: "string" } }, ["workspaceId"]),
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	vehicleRegistry.register(
		OWNER,
		bindVehicleOperation(gitStatus, () => async (context) => {
			const input = context.input;
			return handlers["workspace.gitStatus"](registry, { workspaceId: requireWorkspaceId(input) });
		}),
	);

	const gitLog = defineVehicleOperation({
		name: "workspace.gitLog",
		version: 1,
		description: "Lists a git workspace's recent commits, most recent first, bounded by maxCount.",
		input: defineLooseObjectSchema({ workspaceId: { type: "string" }, maxCount: { type: "number" } }, ["workspaceId", "maxCount"]),
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	vehicleRegistry.register(
		OWNER,
		bindVehicleOperation(gitLog, () => async (context) => {
			const input = context.input;
			return handlers["workspace.gitLog"](registry, { workspaceId: requireWorkspaceId(input), maxCount: requireMaxCount(input) });
		}),
	);

	const gitDiff = defineVehicleOperation({
		name: "workspace.gitDiff",
		version: 1,
		description: "Shows a git workspace's current diff (ref omitted means the working tree), bounded by maxBytes.",
		input: defineLooseObjectSchema({ workspaceId: { type: "string" }, ref: { type: "string" }, maxBytes: { type: "number" } }, ["workspaceId", "maxBytes"]),
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	vehicleRegistry.register(
		OWNER,
		bindVehicleOperation(gitDiff, () => async (context) => {
			const input = context.input;
			return handlers["workspace.gitDiff"](registry, { workspaceId: requireWorkspaceId(input), ref: optionalRef(input), maxBytes: requireMaxBytes(input) });
		}),
	);
}
