import { describe, expect, it } from "bun:test";
import { parseCargoLockSource } from "../../../src/rust-crate-version-resolver/parsers/cargo-lock-source.ts";

describe("parseCargoLockSource", () => {
	it("classifies the default crates.io registry source", () => {
		expect(parseCargoLockSource("registry+https://github.com/rust-lang/crates.io-index")).toEqual({
			kind: "registry",
			registryUrl: "https://github.com/rust-lang/crates.io-index",
			directSource: null,
			commit: null,
			gitRef: null,
		});
	});

	it("classifies an alternate registry source by its own distinct index URL", () => {
		expect(parseCargoLockSource("registry+https://crates.internal.example/index")).toEqual({
			kind: "registry",
			registryUrl: "https://crates.internal.example/index",
			directSource: null,
			commit: null,
			gitRef: null,
		});
	});

	it("extracts a git source's own URL, ref, and exact resolved commit", () => {
		expect(
			parseCargoLockSource(
				"git+https://github.com/example/fixturedep.git?rev=abcdef1234567890abcdef1234567890abcdef12#abcdef1234567890abcdef1234567890abcdef12",
			),
		).toEqual({
			kind: "git",
			registryUrl: null,
			directSource: "https://github.com/example/fixturedep.git",
			commit: "abcdef1234567890abcdef1234567890abcdef12",
			gitRef: null,
		});
	});

	it("extracts a git source pinned by tag rather than an explicit rev", () => {
		expect(parseCargoLockSource("git+https://github.com/example/fixturedep.git?tag=v1.2.3#abcdef1234567890abcdef1234567890abcdef12")).toEqual({
			kind: "git",
			registryUrl: null,
			directSource: "https://github.com/example/fixturedep.git",
			commit: "abcdef1234567890abcdef1234567890abcdef12",
			gitRef: "v1.2.3",
		});
	});

	it("returns null for a path/workspace-local crate with no source field at all", () => {
		expect(parseCargoLockSource(null)).toEqual({ kind: "path", registryUrl: null, directSource: null, commit: null, gitRef: null });
	});
});
