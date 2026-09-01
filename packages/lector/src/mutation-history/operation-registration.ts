/**
 * Revert stays unsafe-to-retry even though every write it makes is hash-guarded: a hash guard
 * only proves "the file still matches what I last saw," it can't prove nothing else raced
 * between a retried revert's own read and write (ABA) -- so a retry must be a brand-new attempt,
 * never silently deduplicated.
 */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { WORKSPACE_READ_PERMISSION, WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import { MutationEntryNotFound, MutationRevertStale, MutationTransactionNotFound, MutationTransactionRevertStale } from "../service/errors.ts";
import type { MutationHistoryHandlers } from "../service/mutation-history-handlers.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import { StaleExpectedHash } from "../workspace/exact-edit.ts";
import { WorkspaceIsReadOnly } from "../workspace/read-only-workspace.ts";
import { mutationHistoryInputSchema, mutationTransactionInputSchema, revertMutationInputSchema } from "./input-schemas.ts";

const OWNER = "lector-mutation-history";

const READ_PERMISSIONS = [WORKSPACE_READ_PERMISSION];
const WRITE_PERMISSIONS = [WORKSPACE_WRITE_PERMISSION];

/** History reads stay in the bounded/small-request-body tier every other read operation uses; revert never carries a large body either -- entryId only, the store already has the content. */
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 8_192, maxResponseBytes: 4 * 1024 * 1024 };

const ENTRY_NOT_FOUND_ERROR = { code: "mutation-entry-not-found", description: "entryId names no recorded mutation" };
const REVERT_STALE_ERROR = {
	code: "mutation-revert-stale",
	description: "the file's current content no longer matches what this entry's own mutation produced",
};
const STALE_HASH_ERROR = {
	code: "stale-expected-hash",
	description: "the file changed between the revert's own staleness check and its write (a real, if narrow, ABA race)",
};
const READ_ONLY_ERROR = { code: "workspace-is-read-only", description: "the workspace is a foreign read-only checkout; revert cannot write to it" };

const TRANSACTION_NOT_FOUND_ERROR = { code: "mutation-transaction-not-found", description: "transactionId names no recorded rename/multi-file transaction" };
const TRANSACTION_REVERT_STALE_ERROR = {
	code: "mutation-transaction-revert-stale",
	description: "at least one member of the transaction no longer matches what it produced -- the whole transaction is refused, never a partial revert",
};

const HISTORY_ERRORS = [UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR];
const REVERT_ERRORS = [UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, ENTRY_NOT_FOUND_ERROR, REVERT_STALE_ERROR, STALE_HASH_ERROR, READ_ONLY_ERROR];
const TRANSACTION_PREVIEW_ERRORS = [UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR];
const TRANSACTION_REVERT_ERRORS = [
	UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR,
	TRANSACTION_NOT_FOUND_ERROR,
	TRANSACTION_REVERT_STALE_ERROR,
	STALE_HASH_ERROR,
	READ_ONLY_ERROR,
];

/** Maps every real domain error these 4 operations can throw onto a coded/categorized VehicleError, preserving the original as `cause`. */
const mapMutationHistoryError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: MutationEntryNotFound, category: "not_found", code: "mutation-entry-not-found" },
	{ errorClass: MutationRevertStale, category: "conflict", code: "mutation-revert-stale" },
	{ errorClass: StaleExpectedHash, category: "conflict", code: "stale-expected-hash" },
	// Not "validation" -- the request shape is fine, the target resource itself refuses this class
	// of operation, the same reason permission-denied-style requests get "authorization".
	{ errorClass: WorkspaceIsReadOnly, category: "authorization", code: "workspace-is-read-only" },
	{ errorClass: MutationTransactionNotFound, category: "not_found", code: "mutation-transaction-not-found" },
	{ errorClass: MutationTransactionRevertStale, category: "conflict", code: "mutation-transaction-revert-stale" },
]);

/** Registers mutation-history contracts without duplicating MutationHistoryHandlers behavior. */
export function registerMutationHistoryOperations(operationRegistry: VehicleRegistry, registry: MutableRegistry, handlers: MutationHistoryHandlers): void {
	const mutationHistory = defineVehicleOperation({
		name: "workspace.mutationHistory",
		version: 1,
		description: "Lists a path's recorded mutation history, newest first, bounded by count and response bytes.",
		input: mutationHistoryInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: HISTORY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(mutationHistory, () => (context) => mapMutationHistoryError(() => handlers["workspace.mutationHistory"](registry, context.input))),
	);

	const revertMutation = defineVehicleOperation({
		name: "workspace.revertMutation",
		version: 1,
		description: "Reverts one recorded mutation, refusing if the file has changed since that mutation's own result.",
		input: revertMutationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "destructive",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
		errors: REVERT_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(revertMutation, () => (context) => mapMutationHistoryError(() => handlers["workspace.revertMutation"](registry, context.input))),
	);

	const mutationTransaction = defineVehicleOperation({
		name: "workspace.mutationTransaction",
		version: 1,
		description: "Previews every entry recorded under one rename/multi-file transaction, bounded the same way workspace.mutationHistory is.",
		input: mutationTransactionInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: TRANSACTION_PREVIEW_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			mutationTransaction,
			() => (context) => mapMutationHistoryError(() => handlers["workspace.mutationTransaction"](registry, context.input)),
		),
	);

	const revertMutationTransaction = defineVehicleOperation({
		name: "workspace.revertMutationTransaction",
		version: 1,
		description:
			"Reverts every member of a rename/multi-file transaction atomically -- refuses the whole thing if even one member is stale, never a partial revert.",
		input: mutationTransactionInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "destructive",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
		errors: TRANSACTION_REVERT_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			revertMutationTransaction,
			() => (context) => mapMutationHistoryError(() => handlers["workspace.revertMutationTransaction"](registry, context.input)),
		),
	);
}

export { READ_PERMISSIONS as MUTATION_HISTORY_READ_PERMISSIONS, WRITE_PERMISSIONS as MUTATION_HISTORY_WRITE_PERMISSIONS };
