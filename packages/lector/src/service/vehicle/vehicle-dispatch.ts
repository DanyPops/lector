/**
 * The seam every Vehicle-migrated OperationHandlers entry routes through: invokes a registered
 * VehicleRegistry operation, then unwraps VehicleError's own "handler-failed" wrapping back to
 * the original thrown error. VehicleRegistry.invoke() preserves a handler's real typed error
 * (NotAGitRepository, UnknownWorkspace, ...) only via the standard Error.cause chain, never as
 * the thrown value's own type (confirmed against Vehicle's real source in Phase 1) -- every
 * existing consumer (pi-lector, alignment-lector, this repo's own tests) still checks Lector's
 * domain errors by `instanceof`, so dispatch() staying externally identical requires unwrapping
 * here, not asking every caller to learn a new failure shape.
 *
 * A VehicleError with no cause (permission-denied, not-found, deadline-exceeded, ...) is a
 * genuinely new failure mode dispatch never had before it started routing through Vehicle --
 * surfaced as-is, never silently swallowed.
 */
import { isVehicleError } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";

export async function dispatchThroughVehicle<T>(
	vehicleRegistry: VehicleRegistry,
	name: string,
	version: number,
	input: unknown,
	permissions: readonly string[],
): Promise<T> {
	try {
		// The registry's own return type is genuinely `unknown` -- validated only against the
		// operation's declared output schema, which this generic helper has no way to thread
		// through as T. Trusted at this exact boundary, the same way language-server-process.ts's
		// own JSON-RPC transport trusts a caller's declared T for an unknown wire payload.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return (await vehicleRegistry.invoke(name, version, input, { permissions })) as T;
	} catch (error) {
		// Only ever rethrow a real Error -- VehicleError.cause is typed `unknown` (Error's own
		// standard cause field), but every cause this module's own handlers ever attach is a real
		// thrown Error; anything else falls through to the VehicleError wrapper itself instead of
		// throwing a non-Error value.
		if (isVehicleError(error) && error.cause instanceof Error) throw error.cause;
		throw error;
	}
}
