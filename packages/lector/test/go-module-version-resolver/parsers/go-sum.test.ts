import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGoSum } from "../../../src/go-module-version-resolver/parsers/go-sum.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/go-reference/", import.meta.url));

function readFixture(relativePath: string): string {
	return readFileSync(`${FIXTURE_ROOT}${relativePath}`, "utf8");
}

describe("parseGoSum", () => {
	it("maps a module@version to its declared h1: content hash, ignoring the separate /go.mod hash line", () => {
		const parsed = parseGoSum(readFixture("go.sum"));
		expect(parsed.get("example.com/fixturedep@v1.2.3")).toEqual({
			checksum: "h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			mismatched: false,
		});
	});

	it("flags a real internally-inconsistent go.sum -- two different content hashes declared for the same module@version", () => {
		const parsed = parseGoSum(readFixture("locks/checksum-mismatch.go.sum.snippet"));
		const entry = parsed.get("example.com/fixturedep@v1.2.3");
		expect(entry?.mismatched).toBe(true);
	});

	it("returns an empty map for a go.sum with no entries", () => {
		expect(parseGoSum("").size).toBe(0);
	});

	it("ignores a malformed line with too few fields rather than throwing", () => {
		expect(parseGoSum("not-a-real-line\n").size).toBe(0);
	});
});
