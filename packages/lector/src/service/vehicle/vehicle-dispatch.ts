/**
 * Invokes a registered VehicleRegistry operation, then unwraps VehicleError's own
 * "handler-failed" wrapping back to the original thrown error. VehicleRegistry.invoke() only
 * preserves a handler's typed error via Error.cause, so pi-lector/alignment-lector/this repo's
 * own `instanceof` checks on Lector's domain errors need this unwrap to keep working.
 * A VehicleError with no cause (permission-denied, not-found, deadline-exceeded, ...) is a new
 * failure mode and is surfaced as-is.
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
		// The registry's return type is `unknown`, validated only against the operation's declared
		// output schema, which this generic helper can't thread through as T. Trusted here, same as
		// language-server-process.ts's JSON-RPC transport trusts a caller's declared T.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return (await vehicleRegistry.invoke(name, version, input, { permissions })) as T;
	} catch (error) {
		// VehicleError.cause is typed `unknown`; only rethrow it when it's a real Error, else
		// rethrow the VehicleError itself rather than throw a non-Error value.
		if (isVehicleError(error) && error.cause instanceof Error) throw error.cause;
		throw error;
	}
}
