import { describe, expect, it } from "bun:test";
import { isLocalReplacePath, looksLikeCommitHash, pseudoVersionCommit } from "../../../src/go-module-version-resolver/parsers/shared.ts";

describe("pseudoVersionCommit", () => {
	it("extracts the trailing 12-hex-char commit from a real pseudo-version", () => {
		expect(pseudoVersionCommit("v0.0.0-20240102030405-abcdef123456")).toBe("abcdef123456");
	});

	it("extracts the commit from a pre-release-form pseudo-version", () => {
		expect(pseudoVersionCommit("v1.2.4-0.20240102030405-abcdef123456")).toBe("abcdef123456");
	});

	it("returns null for a plain tagged semver with no pseudo-version suffix", () => {
		expect(pseudoVersionCommit("v1.2.3")).toBeNull();
	});

	it("returns null for a version whose trailing segment is not exactly 12 hex characters", () => {
		expect(pseudoVersionCommit("v0.0.0-20240102030405-abcdef12345")).toBeNull();
	});
});

describe("looksLikeCommitHash", () => {
	it("accepts a real 40-character hex commit SHA", () => {
		expect(looksLikeCommitHash("abcdef1234567890abcdef1234567890abcdef12")).toBe(true);
	});

	it("rejects a tagged semver version", () => {
		expect(looksLikeCommitHash("v1.2.3")).toBe(false);
	});

	it("rejects a 12-character abbreviated hash -- too short to be a full commit SHA", () => {
		expect(looksLikeCommitHash("abcdef123456")).toBe(false);
	});
});

describe("isLocalReplacePath", () => {
	it("recognizes a relative parent-directory path as local", () => {
		expect(isLocalReplacePath("../local-fixturedep")).toBe(true);
	});

	it("recognizes a relative current-directory path as local", () => {
		expect(isLocalReplacePath("./vendor/patched")).toBe(true);
	});

	it("recognizes an absolute path as local", () => {
		expect(isLocalReplacePath("/opt/patched-module")).toBe(true);
	});

	it("treats a bare module path as remote, not local", () => {
		expect(isLocalReplacePath("github.com/example/vcs-dep")).toBe(false);
	});
});
