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

export interface GitShowFileInput {
	readonly workspaceId: string;
	readonly ref: string;
	readonly path: string;
}

export interface GitGrepInput {
	readonly workspaceId: string;
	readonly ref: string;
	readonly pattern: string;
	readonly pathspecs?: readonly string[];
	readonly maxMatches: number;
	readonly maxBytes: number;
}

export interface GitListFilesInput {
	readonly workspaceId: string;
	readonly ref: string;
	readonly pathspecs?: readonly string[];
	readonly maxResults: number;
}

export interface GitIsAncestorInput {
	readonly workspaceId: string;
	readonly ancestorRef: string;
	readonly ref: string;
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

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
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

export const gitShowFileInputSchema: VehicleSchemaCodec<GitShowFileInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, ref: { type: "string" }, path: { type: "string" } },
		required: ["workspaceId", "ref", "path"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return issue("ref", "ref must be a non-empty string");
		if (!isNonEmptyString(value.path)) return issue("path", "path must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, ref: value.ref, path: value.path } };
	},
});

export const gitGrepInputSchema: VehicleSchemaCodec<GitGrepInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			ref: { type: "string" },
			pattern: { type: "string" },
			pathspecs: { type: "array", items: { type: "string" } },
			maxMatches: { type: "number" },
			maxBytes: { type: "number" },
		},
		required: ["workspaceId", "ref", "pattern", "maxMatches", "maxBytes"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return issue("ref", "ref must be a non-empty string");
		if (typeof value.pattern !== "string" || value.pattern.length === 0) return issue("pattern", "pattern must be a non-empty string");
		if (value.pathspecs !== undefined && !isStringArray(value.pathspecs)) return issue("pathspecs", "pathspecs must be an array of strings when given");
		if (!isPositiveSafeInteger(value.maxMatches)) return issue("maxMatches", "maxMatches must be a positive safe integer");
		if (!isPositiveSafeInteger(value.maxBytes)) return issue("maxBytes", "maxBytes must be a positive safe integer");
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				ref: value.ref,
				pattern: value.pattern,
				pathspecs: value.pathspecs,
				maxMatches: value.maxMatches,
				maxBytes: value.maxBytes,
			},
		};
	},
});

export const gitListFilesInputSchema: VehicleSchemaCodec<GitListFilesInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			ref: { type: "string" },
			pathspecs: { type: "array", items: { type: "string" } },
			maxResults: { type: "number" },
		},
		required: ["workspaceId", "ref", "maxResults"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return issue("ref", "ref must be a non-empty string");
		if (value.pathspecs !== undefined && !isStringArray(value.pathspecs)) return issue("pathspecs", "pathspecs must be an array of strings when given");
		if (!isPositiveSafeInteger(value.maxResults)) return issue("maxResults", "maxResults must be a positive safe integer");
		return { success: true, value: { workspaceId: value.workspaceId, ref: value.ref, pathspecs: value.pathspecs, maxResults: value.maxResults } };
	},
});

export const gitIsAncestorInputSchema: VehicleSchemaCodec<GitIsAncestorInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, ancestorRef: { type: "string" }, ref: { type: "string" } },
		required: ["workspaceId", "ancestorRef", "ref"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isNonEmptyString(value.workspaceId)) return issue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ancestorRef)) return issue("ancestorRef", "ancestorRef must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return issue("ref", "ref must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, ancestorRef: value.ancestorRef, ref: value.ref } };
	},
});
