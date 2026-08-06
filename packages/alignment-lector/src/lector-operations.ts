import { connectLectorClient, type LectorClient } from "@danypops/lector/src/client.ts";
import type { OperationInputs, OperationName } from "@danypops/lector/src/service.ts";

export interface LectorOperations {
	call(operation: string, input: unknown): Promise<unknown>;
}

export function lectorOperationsFromClient(client: LectorClient): LectorOperations {
	return {
		async call(operation, input) {
			// Runtime operation names and payloads originate only from this package's closed command/provider implementation.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const name = operation as OperationName;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return await client.call(name, input as OperationInputs[typeof name]);
		},
	};
}

export function authenticatedLectorOperations(): LectorOperations {
	let connected: ReturnType<typeof connectLectorClient> | undefined;
	return {
		async call(operation, input) {
			connected ??= connectLectorClient();
			try {
				return await lectorOperationsFromClient(await connected).call(operation, input);
			} catch (error) {
				connected = undefined;
				throw error;
			}
		},
	};
}
