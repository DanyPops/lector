/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import type { VehicleSchemaCodec } from "@danypops/vehicle-core";
import type { ExternalSearchInput } from "../../../src/external-search/input-schemas.ts";
import { searchGithubReposInputSchema, searchNpmPackagesInputSchema, searchSourcegraphCodeInputSchema } from "../../../src/external-search/input-schemas.ts";

function exercise(name: string, schema: VehicleSchemaCodec<ExternalSearchInput>): void {
	describe(name, () => {
		it("accepts a valid query and maxResults", () => {
			expect(schema.safeParse({ query: "widgets", maxResults: 10 })).toEqual({ success: true, value: { query: "widgets", maxResults: 10 } });
		});

		it("accepts the upper bound (100) but rejects one past it", () => {
			expect(schema.safeParse({ query: "widgets", maxResults: 100 })).toEqual({ success: true, value: { query: "widgets", maxResults: 100 } });
			expect(schema.safeParse({ query: "widgets", maxResults: 101 })).toEqual({
				success: false,
				issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer no greater than 100" }],
			});
		});

		it("rejects maxResults: 0", () => {
			expect(schema.safeParse({ query: "widgets", maxResults: 0 })).toEqual({
				success: false,
				issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer no greater than 100" }],
			});
		});

		it("rejects a non-integer maxResults", () => {
			expect(schema.safeParse({ query: "widgets", maxResults: 1.5 })).toEqual({
				success: false,
				issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer no greater than 100" }],
			});
		});

		it("rejects an empty query", () => {
			expect(schema.safeParse({ query: "", maxResults: 10 })).toEqual({
				success: false,
				issues: [{ path: ["query"], message: "query must be a non-empty string" }],
			});
		});

		it("rejects a missing query", () => {
			expect(schema.safeParse({ maxResults: 10 })).toEqual({ success: false, issues: [{ path: ["query"], message: "query must be a non-empty string" }] });
		});

		it("rejects a non-object input", () => {
			expect(schema.safeParse("widgets")).toEqual({ success: false, issues: [{ path: [], message: "input must be an object" }] });
			expect(schema.safeParse(null)).toEqual({ success: false, issues: [{ path: [], message: "input must be an object" }] });
		});

		it("declares additionalProperties: false and both fields required in its own jsonSchema", () => {
			expect(schema.jsonSchema).toMatchObject({ additionalProperties: false, required: ["query", "maxResults"] });
		});
	});
}

exercise("searchGithubReposInputSchema", searchGithubReposInputSchema);
exercise("searchNpmPackagesInputSchema", searchNpmPackagesInputSchema);
exercise("searchSourcegraphCodeInputSchema", searchSourcegraphCodeInputSchema);
