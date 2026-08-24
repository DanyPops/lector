import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGoMod } from "../../../src/go-module-version-resolver/parsers/go-mod.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/go-reference/locks/", import.meta.url));

function readFixture(name: string): string {
	return readFileSync(`${FIXTURE_ROOT}${name}`, "utf8");
}

describe("parseGoMod", () => {
	it("parses the module path and a plain require with no replace", () => {
		const parsed = parseGoMod("module fixture.lector.invalid/gomod-reference\n\ngo 1.22\n\nrequire example.com/fixturedep v1.2.3\n");
		expect(parsed.modulePath).toBe("fixture.lector.invalid/gomod-reference");
		expect(parsed.requires).toEqual([{ modulePath: "example.com/fixturedep", version: "v1.2.3", locator: "require example.com/fixturedep v1.2.3" }]);
		expect(parsed.replaces).toEqual([]);
	});

	it("parses a real pseudo-version require", () => {
		const parsed = parseGoMod(readFixture("pseudo-version.go.mod.snippet"));
		expect(parsed.requires).toEqual([
			{
				modulePath: "example.com/fixturedep",
				version: "v0.0.0-20240102030405-abcdef123456",
				locator: "require example.com/fixturedep v0.0.0-20240102030405-abcdef123456",
			},
		]);
	});

	it("parses a local-path replace directive with no version", () => {
		const parsed = parseGoMod(readFixture("replace-directive.go.mod.snippet"));
		expect(parsed.requires).toEqual([{ modulePath: "example.com/fixturedep", version: "v1.2.3", locator: "require example.com/fixturedep v1.2.3" }]);
		expect(parsed.replaces).toEqual([
			{
				oldPath: "example.com/fixturedep",
				oldVersion: null,
				newPath: "../local-fixturedep",
				newVersion: null,
				locator: "replace example.com/fixturedep => ../local-fixturedep",
			},
		]);
	});

	it("parses a direct-VCS replace naming a different module path at an exact commit", () => {
		const parsed = parseGoMod(readFixture("direct-vcs-dependency.go.mod.snippet"));
		expect(parsed.replaces).toEqual([
			{
				oldPath: "example.com/vcs-dep",
				oldVersion: null,
				newPath: "github.com/example/vcs-dep",
				newVersion: "abcdef1234567890abcdef1234567890abcdef12",
				locator: "replace example.com/vcs-dep => github.com/example/vcs-dep abcdef1234567890abcdef1234567890abcdef12",
			},
		]);
	});

	it("parses a private-module require with no matching replace", () => {
		const parsed = parseGoMod(readFixture("private-module.go.mod.snippet"));
		expect(parsed.requires).toEqual([
			{ modulePath: "git.internal.example/team/private-module", version: "v0.3.0", locator: "require git.internal.example/team/private-module v0.3.0" },
		]);
		expect(parsed.replaces).toEqual([]);
	});

	it("parses a grouped require(...) block, ignoring an inline // indirect comment", () => {
		const parsed = parseGoMod("module fixture.lector.invalid/grouped\n\ngo 1.22\n\nrequire (\n\texample.com/a v1.0.0\n\texample.com/b v2.0.0 // indirect\n)\n");
		expect(parsed.requires).toEqual([
			{ modulePath: "example.com/a", version: "v1.0.0", locator: "example.com/a v1.0.0" },
			{ modulePath: "example.com/b", version: "v2.0.0", locator: "example.com/b v2.0.0 // indirect" },
		]);
	});

	it("parses a grouped replace(...) block with both a local and a versioned entry", () => {
		const parsed = parseGoMod(
			"module fixture.lector.invalid/grouped\n\ngo 1.22\n\nreplace (\n\texample.com/a => ../local-a\n\texample.com/b v1.0.0 => example.com/b v1.0.1\n)\n",
		);
		expect(parsed.replaces).toEqual([
			{ oldPath: "example.com/a", oldVersion: null, newPath: "../local-a", newVersion: null, locator: "example.com/a => ../local-a" },
			{
				oldPath: "example.com/b",
				oldVersion: "v1.0.0",
				newPath: "example.com/b",
				newVersion: "v1.0.1",
				locator: "example.com/b v1.0.0 => example.com/b v1.0.1",
			},
		]);
	});

	it("returns a null module path and no requires/replaces for a manifest with neither", () => {
		const parsed = parseGoMod("go 1.22\n");
		expect(parsed.modulePath).toBeNull();
		expect(parsed.requires).toEqual([]);
		expect(parsed.replaces).toEqual([]);
	});
});
