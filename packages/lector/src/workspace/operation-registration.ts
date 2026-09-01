import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import { WorkspaceReleaseBlocked } from "../service/errors.ts";
import type { OperationInputs, OperationOutputs } from "../service/operations.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import { workspaceReleaseInputSchema } from "./lifecycle-input-schemas.ts";

const OWNER = "lector-workspace-lifecycle";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 8_192 };
const ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	{ code: "workspace-release-blocked", description: "the workspace still has an active index lease, background job, or live watch" },
];
const mapReleaseError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: WorkspaceReleaseBlocked, category: "conflict", code: "workspace-release-blocked" },
]);

/** Registers the authenticated workspace lifecycle contract around the existing release handler. */
export function registerWorkspaceLifecycleOperations(
	operationRegistry: VehicleRegistry,
	registry: MutableRegistry,
	releaseHandler: (registry: MutableRegistry, input: OperationInputs["workspace.release"]) => Promise<OperationOutputs["workspace.release"]>,
): void {
	const release = defineVehicleOperation({
		name: "workspace.release",
		version: 1,
		description: "Closes idle workspace resources and unregisters the opaque workspace identity when no consumer still holds it.",
		input: workspaceReleaseInputSchema,
		output: passthroughVehicleSchema,
		permissions: [WORKSPACE_WRITE_PERMISSION],
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
		errors: ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(release, () => (context) => mapReleaseError(() => releaseHandler(registry, context.input))),
	);
}
