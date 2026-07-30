import { describe, expect, it } from "bun:test";
import { splitSourcegraphRepository } from "../../src/domain/external-search-result.ts";

describe("splitSourcegraphRepository", () => {
	it("splits a well-formed host/owner/repo path", () => {
		expect(splitSourcegraphRepository("github.com/acme/widgets")).toEqual({ host: "github.com", owner: "acme", repo: "widgets" });
	});

	it("returns null for too few segments", () => {
		expect(splitSourcegraphRepository("acme/widgets")).toBeNull();
	});

	it("returns null for too many segments", () => {
		expect(splitSourcegraphRepository("github.com/acme/widgets/extra")).toBeNull();
	});

	it("returns null for an empty segment", () => {
		expect(splitSourcegraphRepository("github.com//widgets")).toBeNull();
	});
});
