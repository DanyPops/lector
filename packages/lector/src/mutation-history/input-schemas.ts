/**
 * Type-narrowing input schemas for workspace.mutationHistory/workspace.revertMutation.
 * maxResults stays required (existing callers already pass it); maxBytes is a new optional
 * field the handler defaults/bounds via resolveBound -- neither field's own numeric ceiling is
 * enforced here, only its shape, matching every other migrated capability's schema/handler split.
 */
import {
	defineVehicleSchema,
	isNonEmptyString,
	isPlainObject,
	isPositiveSafeInteger,
	notAnObjectIssue,
	schemaIssue,
	type VehicleSchemaCodec,
} from "@danypops/vehicle-core";

export interface MutationHistoryInput {
	readonly workspaceId: string;
	readonly path: string;
	readonly maxResults: number;
	readonly maxBytes?: number;
}

export interface RevertMutationInput {
	readonly workspaceId: string;
	readonly entryId: string;
}

export interface MutationTransactionInput {
	readonly workspaceId: string;
	readonly transactionId: string;
}

export const mutationHistoryInputSchema: VehicleSchemaCodec<MutationHistoryInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, path: { type: "string" }, maxResults: { type: "number" }, maxBytes: { type: "number" } },
		required: ["workspaceId", "path", "maxResults"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.path)) return schemaIssue("path", "path must be a non-empty string");
		if (!isPositiveSafeInteger(value.maxResults)) return schemaIssue("maxResults", "maxResults must be a positive safe integer");
		if (value.maxBytes !== undefined && !isPositiveSafeInteger(value.maxBytes))
			return schemaIssue("maxBytes", "maxBytes must be a positive safe integer when given");
		return { success: true, value: { workspaceId: value.workspaceId, path: value.path, maxResults: value.maxResults, maxBytes: value.maxBytes } };
	},
});

export const revertMutationInputSchema: VehicleSchemaCodec<RevertMutationInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, entryId: { type: "string" } },
		required: ["workspaceId", "entryId"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.entryId)) return schemaIssue("entryId", "entryId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, entryId: value.entryId } };
	},
});

export const mutationTransactionInputSchema: VehicleSchemaCodec<MutationTransactionInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, transactionId: { type: "string" } },
		required: ["workspaceId", "transactionId"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.transactionId)) return schemaIssue("transactionId", "transactionId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, transactionId: value.transactionId } };
	},
});
