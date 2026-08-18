import { createRetryingLectorClient, remoteErrorIs } from "@danypops/lector/client";
import type { OperationInputs, OperationName, OperationOutputs } from "@danypops/lector/service";
import type { WorkspaceRootRegistry } from "./workspace-root-registry.js";

export interface LectorOperations {
	call(operation: string, input: unknown): Promise<unknown>;
}

interface MinimalLectorClient {
	call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]>;
}

export function lectorOperationsFromClient(client: MinimalLectorClient): LectorOperations {
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

/**
 * Uses @danypops/lector's own shared retrying, identity-aware client (createRetryingLectorClient)
 * instead of the hand-rolled "cache a connection, drop it on any error" this used to do -- that
 * older version never retried the failing call itself, so the very first call after a daemon
 * restart surfaced a raw connection error to the caller instead of transparently reconnecting.
 */
export function authenticatedLectorOperations(): LectorOperations {
	const client = createRetryingLectorClient();
	return lectorOperationsFromClient({ call: (operation, input) => client.call(operation, input) });
}

function workspaceIdFromInput(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null || !("workspaceId" in input)) return undefined;
	const value = input.workspaceId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Wraps `inner` so a call whose input names a workspaceId `roots` knows the root path for
 * transparently recovers from UnknownWorkspace. A Lector daemon restart wipes its in-memory
 * workspace registry by design (never persisted) -- but deriveWorkspaceId is a deterministic
 * hash of the absolute root path, so re-registering the exact same path always yields the
 * identical id back. One re-register plus one retry of the exact original call, never more than
 * once, mirrors pi-lector's own proven withWorkspace recovery (extension/src/lector-client.ts) at
 * the one seam every zodiac-lector contribution's call already funnels through.
 */
export function withWorkspaceRecovery(inner: LectorOperations, roots: WorkspaceRootRegistry): LectorOperations {
	return {
		async call(operation, input) {
			try {
				return await inner.call(operation, input);
			} catch (error) {
				if (!remoteErrorIs(error, "UnknownWorkspace")) throw error;
				const workspaceId = workspaceIdFromInput(input);
				const root = workspaceId ? roots.recall(workspaceId) : undefined;
				if (!root) throw error;
				await inner.call("workspace.registerPath", { path: root });
				return await inner.call(operation, input);
			}
		},
	};
}
