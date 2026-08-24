import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePoetryLock } from "../../../src/python-package-version-resolver/parsers/poetry-lock.ts";
import { PythonResolutionContext } from "../../../src/python-package-version-resolver/resolution-context.ts";

const FIXTURE_ROOT = join(import.meta.dirname, "../../../test/fixtures/python-reference");
const BOUNDS = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxManifestNesting: 64,
	maxDiagnostics: 20,
	maxCandidates: 20,
	maxEvidencePerVersion: 20,
};

function context(): PythonResolutionContext {
	return new PythonResolutionContext(FIXTURE_ROOT, BOUNDS);
}

describe("parsePoetryLock", () => {
	it("returns every real matching entry -- two distinct versions of the same package (main + dev extra), letting the caller detect the ambiguity", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/poetry/poetry.lock"), "utf8");
		const parsed = parsePoetryLock(text, "poetry.lock", "requests", context());
		expect(parsed.map((entry) => entry.version).sort()).toEqual(["2.31.0", "2.32.3"]);
		for (const entry of parsed)
			expect(entry.evidence).toEqual({ manager: "poetry", lockfile: "poetry.lock", locator: "requests", kind: "registry", directSource: null, commit: null });
	});

	it("normalizes PEP 503 name variants", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/poetry/poetry.lock"), "utf8");
		expect(parsePoetryLock(text, "poetry.lock", "Requests", context())).toHaveLength(2);
	});

	it("returns no evidence for a package the lockfile never mentions", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/poetry/poetry.lock"), "utf8");
		expect(parsePoetryLock(text, "poetry.lock", "does-not-exist", context())).toEqual([]);
	});

	it("classifies a git-sourced dependency as direct-vcs with its own pinned commit", () => {
		const text = [
			"[[package]]",
			'name = "git-dep"',
			'version = "0.1.0"',
			"",
			"[package.source]",
			'type = "git"',
			'url = "https://github.com/example/git-dep.git"',
			'resolved_reference = "abcdef1234567890abcdef1234567890abcdef12"',
		].join("\n");
		const parsed = parsePoetryLock(text, "poetry.lock", "git-dep", context());
		expect(parsed).toEqual([
			{
				version: "0.1.0",
				evidence: {
					manager: "poetry",
					lockfile: "poetry.lock",
					locator: "git-dep",
					kind: "direct-vcs",
					directSource: "https://github.com/example/git-dep.git",
					commit: "abcdef1234567890abcdef1234567890abcdef12",
				},
			},
		]);
	});

	it("classifies a local directory/file-sourced dependency as editable", () => {
		const text = ["[[package]]", 'name = "local-dep"', 'version = "0.2.0"', "", "[package.source]", 'type = "directory"', 'url = "../local-dep"'].join("\n");
		const parsed = parsePoetryLock(text, "poetry.lock", "local-dep", context());
		expect(parsed).toEqual([
			{
				version: "0.2.0",
				evidence: { manager: "poetry", lockfile: "poetry.lock", locator: "local-dep", kind: "editable", directSource: "../local-dep", commit: null },
			},
		]);
	});
});
