/**
 * Type-narrowing input schemas for workspace.mutationHistory/workspace.revertMutation.
 * maxResults stays required (existing callers already pass it); maxBytes is a new optional
 * field the handler defaults/bounds via resolveBound -- neither field's own numeric ceiling is
 * enforced here, only its shape, matching every other migrated capability's schema/handler split.
 */
import { defineVehicleSchema, type VehicleSchemaCodec, type VehicleSchemaIssue } from "@danypops/vehicle-core";

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

function notAnObject(): { readonly success: false; readonly issues: readonly VehicleSchemaIssue[] } {
	return { success: false, issues: [{ path: [], message: "input must be an object" }] };
}

function issue(path: string, message: string): { readonly success: false; readonly issues: readonly VehicleSchemaIssue[] } {
	return { success: false, issues: [{ path: [path], message }] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export const mutationHistoryInputSchema: VehicleSchemaCodec<MutationHistoryInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, path: { type: "string" }, maxResults: { type: "number" }, maxBytes: { type: "number" } },
		required: ["workspaceId", "path", "maxResults"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.path)) return issue("path", "path must be a non-empty string");
		if (!isPositiveSafeInteger(value.maxResults)) return issue("maxResults", "maxResults must be a positive safe integer");
		if (value.maxBytes !== undefined && !isPositiveSafeInteger(value.maxBytes)) return issue("maxBytes", "maxBytes must be a positive safe integer when given");
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
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.entryId)) return issue("entryId", "entryId must be a non-empty string");
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
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.transactionId)) return issue("transactionId", "transactionId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, transactionId: value.transactionId } };
	},
});
