import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCargoLock } from "../../../src/rust-crate-version-resolver/parsers/cargo-lock.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/rust-reference/", import.meta.url));

function readFixture(relativePath: string): string {
	return readFileSync(`${FIXTURE_ROOT}${relativePath}`, "utf8");
}

describe("parseCargoLock", () => {
	it("parses the real fixture Cargo.lock's own workspace-local packages with no source at all", () => {
		const parsed = parseCargoLock(readFixture("Cargo.lock"));
		expect(parsed).toContainEqual({ name: "contracts", version: "0.1.0", source: null, checksum: null, locator: "[[package]] contracts 0.1.0" });
	});

	it("parses a registry package with a real checksum", () => {
		const parsed = parseCargoLock(
			'[[package]]\nname = "fixturedep"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aaaa"\n',
		);
		expect(parsed).toEqual([
			{
				name: "fixturedep",
				version: "1.2.3",
				source: "registry+https://github.com/rust-lang/crates.io-index",
				checksum: "aaaa",
				locator: "[[package]] fixturedep 1.2.3",
			},
		]);
	});

	it("returns every entry, including duplicate name@version pairs -- mismatch detection is the orchestrator's own job", () => {
		const parsed = parseCargoLock(readFixture("locks/checksum-mismatch.Cargo.lock.snippet"));
		expect(parsed).toHaveLength(2);
		expect(parsed[0]?.checksum).not.toBe(parsed[1]?.checksum);
	});

	it("returns null checksum for a yanked-with-missing-metadata entry, not an error", () => {
		const parsed = parseCargoLock(readFixture("locks/yanked-missing-metadata.Cargo.lock.snippet"));
		expect(parsed).toEqual([
			{
				name: "yanked-dep",
				version: "0.9.0",
				source: "registry+https://github.com/rust-lang/crates.io-index",
				checksum: null,
				locator: "[[package]] yanked-dep 0.9.0",
			},
		]);
	});

	it("returns an empty array for a Cargo.lock with no [[package]] entries", () => {
		expect(parseCargoLock("version = 4\n")).toEqual([]);
	});
});
