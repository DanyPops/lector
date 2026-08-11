import { defineVehicleSchema, type VehicleSchemaCodec, type VehicleSchemaIssue } from "@danypops/vehicle-core";

export interface ExternalSearchInput {
	readonly query: string;
	readonly maxResults: number;
}

type ParseFailure = { readonly success: false; readonly issues: readonly VehicleSchemaIssue[] };
type ParseResult = ParseFailure | { readonly success: true; readonly value: ExternalSearchInput };

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

function isPositiveSafeInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

/** Matches external-search-handlers.ts's own MAX_EXTERNAL_SEARCH_RESULTS, kept in sync here rather than imported to avoid a schema module depending on the handler module it validates for. */
const MAX_EXTERNAL_SEARCH_RESULTS = 100;

function parseExternalSearchInput(value: Record<string, unknown>): ParseResult {
	if (!isNonEmptyString(value.query)) return issue("query", "query must be a non-empty string");
	if (!isPositiveSafeInteger(value.maxResults, MAX_EXTERNAL_SEARCH_RESULTS))
		return issue("maxResults", `maxResults must be a positive safe integer no greater than ${MAX_EXTERNAL_SEARCH_RESULTS}`);
	return { success: true, value: { query: value.query, maxResults: value.maxResults } };
}

/**
 * Shared by search.githubRepos/search.npmPackages/search.sourcegraphCode -- identical shape
 * today (query + a bounded maxResults), but each operation keeps its own named schema constant
 * (matching repo.fetch/repo.evictCache's own separately-named-but-identically-shaped precedent)
 * so a future source-specific field never forces a shared type apart.
 */
function buildExternalSearchSchema(): VehicleSchemaCodec<ExternalSearchInput> {
	return defineVehicleSchema({
		jsonSchema: {
			type: "object",
			properties: { query: { type: "string" }, maxResults: { type: "number" } },
			required: ["query", "maxResults"],
			additionalProperties: false,
		},
		safeParse(value) {
			if (!isPlainObject(value)) return notAnObject();
			return parseExternalSearchInput(value);
		},
	});
}

export const searchGithubReposInputSchema: VehicleSchemaCodec<ExternalSearchInput> = buildExternalSearchSchema();
export const searchNpmPackagesInputSchema: VehicleSchemaCodec<ExternalSearchInput> = buildExternalSearchSchema();
export const searchSourcegraphCodeInputSchema: VehicleSchemaCodec<ExternalSearchInput> = buildExternalSearchSchema();
