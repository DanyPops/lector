import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVendorModulesTxt } from "../../../src/go-module-version-resolver/parsers/vendor-modules.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/go-reference/vendor/modules.txt", import.meta.url));

describe("parseVendorModulesTxt", () => {
	it("parses a real vendor/modules.txt module header, skipping its own metadata and package-path lines", () => {
		const parsed = parseVendorModulesTxt(readFileSync(FIXTURE, "utf8"));
		expect(parsed).toEqual([{ modulePath: "example.com/fixturedep", version: "v1.2.3", locator: "# example.com/fixturedep v1.2.3" }]);
	});

	it("parses multiple module headers, each with their own package-path and metadata lines", () => {
		const parsed = parseVendorModulesTxt(
			"# example.com/a v1.0.0\n## explicit; go 1.22\nexample.com/a\nexample.com/a/sub\n# example.com/b v2.0.0\n## explicit\nexample.com/b\n",
		);
		expect(parsed).toEqual([
			{ modulePath: "example.com/a", version: "v1.0.0", locator: "# example.com/a v1.0.0" },
			{ modulePath: "example.com/b", version: "v2.0.0", locator: "# example.com/b v2.0.0" },
		]);
	});

	it("returns an empty array for a vendor/modules.txt with no module headers", () => {
		expect(parseVendorModulesTxt("")).toEqual([]);
	});
});
