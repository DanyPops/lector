import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCargoToml } from "../../../src/rust-crate-version-resolver/parsers/cargo-toml.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/rust-reference/locks/", import.meta.url));

function readFixture(name: string): string {
	return readFileSync(`${FIXTURE_ROOT}${name}`, "utf8");
}

describe("parseCargoToml", () => {
	it("finds a renamed dependency's own real crate name", () => {
		const parsed = parseCargoToml(readFixture("renamed-dependency.Cargo.toml.snippet"));
		expect(parsed.dependencies.get("json")).toMatchObject({ realName: "serde_json", registryName: null, git: null, path: null });
	});

	it("finds an alternate-registry dependency, resolved against the [registries] table", () => {
		const parsed = parseCargoToml(readFixture("alternate-registry.Cargo.toml.snippet"));
		expect(parsed.dependencies.get("internal-crate")).toMatchObject({ realName: null, registryName: "internal" });
		expect(parsed.registries.get("internal")).toBe("https://crates.internal.example/index");
	});

	it("finds a git dependency's own url and exact rev", () => {
		const parsed = parseCargoToml(readFixture("git-dependency.Cargo.toml.snippet"));
		expect(parsed.dependencies.get("fixturedep")).toMatchObject({
			git: { url: "https://github.com/example/fixturedep.git", rev: "abcdef1234567890abcdef1234567890abcdef12", tag: null, branch: null },
		});
	});

	it("finds a git dependency pinned by tag rather than rev", () => {
		const parsed = parseCargoToml(readFixture("mismatched-tag.Cargo.toml.snippet"));
		expect(parsed.dependencies.get("fixturedep")).toMatchObject({
			git: { url: "https://github.com/example/fixturedep.git", rev: null, tag: "v9.9.9", branch: null },
		});
	});

	it("finds a plain path dependency", () => {
		const parsed = parseCargoToml('[dependencies]\ncontracts = { path = "../contracts" }\n');
		expect(parsed.dependencies.get("contracts")).toMatchObject({ path: "../contracts" });
	});

	it("finds a plain version-only dependency with no rename/registry/git/path", () => {
		const parsed = parseCargoToml('[dependencies]\nserde = "1.0"\n');
		expect(parsed.dependencies.get("serde")).toMatchObject({ realName: null, registryName: null, git: null, path: null });
	});

	it("returns an empty dependency map for a manifest with no [dependencies] table", () => {
		expect(parseCargoToml('[package]\nname = "widget"\n').dependencies.size).toBe(0);
	});
});
