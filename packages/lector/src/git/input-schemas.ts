/**
 * Type-narrowing input schemas for workspace.gitStatus/gitLog/gitDiff. A malformed value (wrong
 * type, missing field) fails at VehicleRegistry.invoke()'s parseInput step with a structured
 * VehicleError("invalid-input", ..., { category: "validation", details: { issues } }) before the
 * handler runs. Each schema's `context.input` in bind() is the typed shape below
 * (GitStatusInput/GitLogInput/GitDiffInput).
 */
import { defineVehicleSchema, type VehicleSchemaCodec, type VehicleSchemaIssue } from "@danypops/vehicle-core";

export interface GitStatusInput {
	readonly workspaceId: string;
}

export interface GitLogInput {
	readonly workspaceId: string;
	readonly maxCount: number;
}

export interface GitDiffInput {
	readonly workspaceId: string;
	readonly ref?: string;
	readonly maxBytes: number;
}

export interface GitWorktreeAddInput {
	readonly workspaceId: string;
	readonly ref: string;
	/** Recreates an already-reused worktree at the current tip of `ref` instead of returning the existing one -- the ref itself may have moved since it was first added. */
	readonly forceRefresh?: boolean;
}

export interface GitWorktreeRemoveInput {
	readonly workspaceId: string;
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

export const gitStatusInputSchema: VehicleSchemaCodec<GitStatusInput> = defineVehicleSchema({
	jsonSchema: { type: "object", properties: { workspaceId: { type: "string" } }, required: ["workspaceId"], additionalProperties: false },
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId } };
	},
});

export const gitLogInputSchema: VehicleSchemaCodec<GitLogInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, maxCount: { type: "number" } },
		required: ["workspaceId", "maxCount"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isPositiveSafeInteger(value.maxCount)) return issue("maxCount", "maxCount must be a positive safe integer");
		return { success: true, value: { workspaceId: value.workspaceId, maxCount: value.maxCount } };
	},
});

export const gitDiffInputSchema: VehicleSchemaCodec<GitDiffInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, ref: { type: "string" }, maxBytes: { type: "number" } },
		required: ["workspaceId", "maxBytes"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (value.ref !== undefined && typeof value.ref !== "string") return issue("ref", "ref must be a string when given");
		if (!isPositiveSafeInteger(value.maxBytes)) return issue("maxBytes", "maxBytes must be a positive safe integer");
		return { success: true, value: { workspaceId: value.workspaceId, ref: value.ref, maxBytes: value.maxBytes } };
	},
});

export const gitWorktreeAddInputSchema: VehicleSchemaCodec<GitWorktreeAddInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, ref: { type: "string" }, forceRefresh: { type: "boolean" } },
		required: ["workspaceId", "ref"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return issue("ref", "ref must be a non-empty string");
		if (value.forceRefresh !== undefined && typeof value.forceRefresh !== "boolean") return issue("forceRefresh", "forceRefresh must be a boolean when given");
		return { success: true, value: { workspaceId: value.workspaceId, ref: value.ref, forceRefresh: value.forceRefresh } };
	},
});

export const gitWorktreeRemoveInputSchema: VehicleSchemaCodec<GitWorktreeRemoveInput> = defineVehicleSchema({
	jsonSchema: { type: "object", properties: { workspaceId: { type: "string" } }, required: ["workspaceId"], additionalProperties: false },
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId } };
	},
});
