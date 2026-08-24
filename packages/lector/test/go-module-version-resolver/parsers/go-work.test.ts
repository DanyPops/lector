import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGoWork } from "../../../src/go-module-version-resolver/parsers/go-work.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/go-reference/go.work", import.meta.url));

describe("parseGoWork", () => {
	it("parses a real grouped use(...) block's own directories", () => {
		const parsed = parseGoWork(readFileSync(FIXTURE, "utf8"));
		expect(parsed.useDirectories).toEqual([".", "./modules/nested"]);
	});

	it("parses a single-line use directive", () => {
		const parsed = parseGoWork("go 1.22\n\nuse ./services/api\n");
		expect(parsed.useDirectories).toEqual(["./services/api"]);
	});

	it("returns no directories for a go.work with no use directive at all", () => {
		expect(parseGoWork("go 1.22\n").useDirectories).toEqual([]);
	});
});
