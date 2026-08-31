/**
 * Type-narrowing input schemas for workspace.gitStatus/gitLog/gitDiff. A malformed value (wrong
 * type, missing field) fails at VehicleRegistry.invoke()'s parseInput step with a structured
 * VehicleError("invalid-input", ..., { category: "validation", details: { issues } }) before the
 * handler runs. Each schema's `context.input` in bind() is the typed shape below
 * (GitStatusInput/GitLogInput/GitDiffInput).
 */
import {
	defineVehicleSchema,
	isNonEmptyString,
	isPlainObject,
	isPositiveSafeInteger,
	isStringArray,
	notAnObjectIssue,
	schemaIssue,
	type VehicleSchemaCodec,
} from "@danypops/vehicle-core";

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

export interface GitGrepHistoryInput {
	readonly workspaceId: string;
	readonly pattern: string;
	readonly pathspecs?: readonly string[];
	readonly commitOffset: number;
	readonly maxCommits: number;
	readonly maxMatches: number;
	readonly maxBytes: number;
	readonly deadlineMs: number;
}

export const GIT_HISTORY_SEARCH_LIMITS = {
	maxPatternCharacters: 4_096,
	maxPathspecs: 64,
	maxPathspecCharacters: 1_024,
	maxCommitOffset: 1_000_000,
	maxCommits: 512,
	maxMatches: 10_000,
	maxBytes: 8 * 1024 * 1024,
	maxDeadlineMs: 120_000,
} as const;

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

export const gitStatusInputSchema: VehicleSchemaCodec<GitStatusInput> = defineVehicleSchema({
	jsonSchema: { type: "object", properties: { workspaceId: { type: "string" } }, required: ["workspaceId"], additionalProperties: false },
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isPositiveSafeInteger(value.maxCount)) return schemaIssue("maxCount", "maxCount must be a positive safe integer");
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (value.ref !== undefined && typeof value.ref !== "string") return schemaIssue("ref", "ref must be a string when given");
		if (!isPositiveSafeInteger(value.maxBytes)) return schemaIssue("maxBytes", "maxBytes must be a positive safe integer");
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return schemaIssue("ref", "ref must be a non-empty string");
		if (value.forceRefresh !== undefined && typeof value.forceRefresh !== "boolean")
			return schemaIssue("forceRefresh", "forceRefresh must be a boolean when given");
		return { success: true, value: { workspaceId: value.workspaceId, ref: value.ref, forceRefresh: value.forceRefresh } };
	},
});

export const gitWorktreeRemoveInputSchema: VehicleSchemaCodec<GitWorktreeRemoveInput> = defineVehicleSchema({
	jsonSchema: { type: "object", properties: { workspaceId: { type: "string" } }, required: ["workspaceId"], additionalProperties: false },
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return schemaIssue("ref", "ref must be a non-empty string");
		if (!isNonEmptyString(value.path)) return schemaIssue("path", "path must be a non-empty string");
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return schemaIssue("ref", "ref must be a non-empty string");
		if (typeof value.pattern !== "string" || value.pattern.length === 0) return schemaIssue("pattern", "pattern must be a non-empty string");
		if (value.pathspecs !== undefined && !isStringArray(value.pathspecs)) return schemaIssue("pathspecs", "pathspecs must be an array of strings when given");
		if (!isPositiveSafeInteger(value.maxMatches)) return schemaIssue("maxMatches", "maxMatches must be a positive safe integer");
		if (!isPositiveSafeInteger(value.maxBytes)) return schemaIssue("maxBytes", "maxBytes must be a positive safe integer");
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

export const gitGrepHistoryInputSchema: VehicleSchemaCodec<GitGrepHistoryInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			pattern: { type: "string", maxLength: GIT_HISTORY_SEARCH_LIMITS.maxPatternCharacters },
			pathspecs: {
				type: "array",
				items: { type: "string", maxLength: GIT_HISTORY_SEARCH_LIMITS.maxPathspecCharacters },
				maxItems: GIT_HISTORY_SEARCH_LIMITS.maxPathspecs,
			},
			commitOffset: { type: "number", minimum: 0, maximum: GIT_HISTORY_SEARCH_LIMITS.maxCommitOffset },
			maxCommits: { type: "number", minimum: 1, maximum: GIT_HISTORY_SEARCH_LIMITS.maxCommits },
			maxMatches: { type: "number", minimum: 1, maximum: GIT_HISTORY_SEARCH_LIMITS.maxMatches },
			maxBytes: { type: "number", minimum: 1, maximum: GIT_HISTORY_SEARCH_LIMITS.maxBytes },
			deadlineMs: { type: "number", minimum: 1, maximum: GIT_HISTORY_SEARCH_LIMITS.maxDeadlineMs },
		},
		required: ["workspaceId", "pattern", "commitOffset", "maxCommits", "maxMatches", "maxBytes", "deadlineMs"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.pattern) || value.pattern.length > GIT_HISTORY_SEARCH_LIMITS.maxPatternCharacters)
			return schemaIssue("pattern", `pattern must contain 1-${GIT_HISTORY_SEARCH_LIMITS.maxPatternCharacters} characters`);
		if (value.pathspecs !== undefined) {
			if (!isStringArray(value.pathspecs)) return schemaIssue("pathspecs", "pathspecs must be an array of strings when given");
			if (value.pathspecs.length > GIT_HISTORY_SEARCH_LIMITS.maxPathspecs)
				return schemaIssue("pathspecs", `pathspecs must contain at most ${GIT_HISTORY_SEARCH_LIMITS.maxPathspecs} entries`);
			if (value.pathspecs.some((pathspec) => pathspec.length === 0 || pathspec.length > GIT_HISTORY_SEARCH_LIMITS.maxPathspecCharacters))
				return schemaIssue("pathspecs", `each pathspec must contain 1-${GIT_HISTORY_SEARCH_LIMITS.maxPathspecCharacters} characters`);
		}
		if (
			!Number.isSafeInteger(value.commitOffset) ||
			typeof value.commitOffset !== "number" ||
			value.commitOffset < 0 ||
			value.commitOffset > GIT_HISTORY_SEARCH_LIMITS.maxCommitOffset
		)
			return schemaIssue("commitOffset", `commitOffset must be a safe integer from 0-${GIT_HISTORY_SEARCH_LIMITS.maxCommitOffset}`);
		if (!isPositiveSafeInteger(value.maxCommits) || value.maxCommits > GIT_HISTORY_SEARCH_LIMITS.maxCommits)
			return schemaIssue("maxCommits", `maxCommits must be a positive safe integer at most ${GIT_HISTORY_SEARCH_LIMITS.maxCommits}`);
		if (!isPositiveSafeInteger(value.maxMatches) || value.maxMatches > GIT_HISTORY_SEARCH_LIMITS.maxMatches)
			return schemaIssue("maxMatches", `maxMatches must be a positive safe integer at most ${GIT_HISTORY_SEARCH_LIMITS.maxMatches}`);
		if (!isPositiveSafeInteger(value.maxBytes) || value.maxBytes > GIT_HISTORY_SEARCH_LIMITS.maxBytes)
			return schemaIssue("maxBytes", `maxBytes must be a positive safe integer at most ${GIT_HISTORY_SEARCH_LIMITS.maxBytes}`);
		if (!isPositiveSafeInteger(value.deadlineMs) || value.deadlineMs > GIT_HISTORY_SEARCH_LIMITS.maxDeadlineMs)
			return schemaIssue("deadlineMs", `deadlineMs must be a positive safe integer at most ${GIT_HISTORY_SEARCH_LIMITS.maxDeadlineMs}`);
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				pattern: value.pattern,
				pathspecs: value.pathspecs,
				commitOffset: value.commitOffset,
				maxCommits: value.maxCommits,
				maxMatches: value.maxMatches,
				maxBytes: value.maxBytes,
				deadlineMs: value.deadlineMs,
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return schemaIssue("ref", "ref must be a non-empty string");
		if (value.pathspecs !== undefined && !isStringArray(value.pathspecs)) return schemaIssue("pathspecs", "pathspecs must be an array of strings when given");
		if (!isPositiveSafeInteger(value.maxResults)) return schemaIssue("maxResults", "maxResults must be a positive safe integer");
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
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.ancestorRef)) return schemaIssue("ancestorRef", "ancestorRef must be a non-empty string");
		if (!isNonEmptyString(value.ref)) return schemaIssue("ref", "ref must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, ancestorRef: value.ancestorRef, ref: value.ref } };
	},
});
