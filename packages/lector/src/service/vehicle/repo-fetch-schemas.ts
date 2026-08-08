import { defineVehicleSchema, type VehicleSchemaCodec, type VehicleSchemaIssue } from "@danypops/vehicle-core";

export interface RepoFetchInput {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	readonly ref: string | null;
	readonly forceRefresh?: boolean;
}

export interface RepoEvictCacheInput {
	readonly host: string;
	readonly owner: string;
	readonly repo: string;
	readonly ref: string | null;
}

export interface RepoListCacheInput {
	readonly text?: string;
	readonly host?: string;
	readonly owner?: string;
	readonly repo?: string;
	readonly ref?: string;
	readonly maxResults: number;
	readonly cursor?: string;
}

type ParseFailure = { readonly success: false; readonly issues: readonly VehicleSchemaIssue[] };

function notAnObject(): ParseFailure {
	return { success: false, issues: [{ path: [], message: "input must be an object" }] };
}

function issue(path: string, message: string): ParseFailure {
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

/** host/owner/repo/ref shared by repo.fetch and repo.evictCache -- ref is required (null means "the remote's default branch"), never merely optional. */
function parseRepoReference(value: Record<string, unknown>): { host: string; owner: string; repo: string; ref: string | null } | ParseFailure {
	if (!isNonEmptyString(value.host)) return issue("host", "host must be a non-empty string");
	if (!isNonEmptyString(value.owner)) return issue("owner", "owner must be a non-empty string");
	if (!isNonEmptyString(value.repo)) return issue("repo", "repo must be a non-empty string");
	if (!("ref" in value)) return issue("ref", "ref is required (use null for the remote's default branch)");
	if (value.ref !== null && typeof value.ref !== "string") return issue("ref", "ref must be a string or null");
	return { host: value.host, owner: value.owner, repo: value.repo, ref: value.ref };
}

export const repoFetchInputSchema: VehicleSchemaCodec<RepoFetchInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { host: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, ref: { type: "string" }, forceRefresh: { type: "boolean" } },
		required: ["host", "owner", "repo", "ref"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		const reference = parseRepoReference(value);
		if ("success" in reference) return reference;
		if (value.forceRefresh !== undefined && typeof value.forceRefresh !== "boolean") return issue("forceRefresh", "forceRefresh must be a boolean when given");
		return { success: true, value: { ...reference, forceRefresh: value.forceRefresh } };
	},
});

export const repoEvictCacheInputSchema: VehicleSchemaCodec<RepoEvictCacheInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { host: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, ref: { type: "string" } },
		required: ["host", "owner", "repo", "ref"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		const reference = parseRepoReference(value);
		if ("success" in reference) return reference;
		return { success: true, value: reference };
	},
});

export const repoListCacheInputSchema: VehicleSchemaCodec<RepoListCacheInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			text: { type: "string" },
			host: { type: "string" },
			owner: { type: "string" },
			repo: { type: "string" },
			ref: { type: "string" },
			maxResults: { type: "number" },
			cursor: { type: "string" },
		},
		required: ["maxResults"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObject();
		if (!isPositiveSafeInteger(value.maxResults)) return issue("maxResults", "maxResults must be a positive safe integer");
		if (value.text !== undefined && typeof value.text !== "string") return issue("text", "text must be a string when given");
		if (value.host !== undefined && typeof value.host !== "string") return issue("host", "host must be a string when given");
		if (value.owner !== undefined && typeof value.owner !== "string") return issue("owner", "owner must be a string when given");
		if (value.repo !== undefined && typeof value.repo !== "string") return issue("repo", "repo must be a string when given");
		if (value.ref !== undefined && typeof value.ref !== "string") return issue("ref", "ref must be a string when given");
		if (value.cursor !== undefined && typeof value.cursor !== "string") return issue("cursor", "cursor must be a string when given");
		return {
			success: true,
			value: { text: value.text, host: value.host, owner: value.owner, repo: value.repo, ref: value.ref, maxResults: value.maxResults, cursor: value.cursor },
		};
	},
});
