import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePipfileLock } from "../../../src/python-package-version-resolver/parsers/pipfile-lock.ts";
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

describe("parsePipfileLock", () => {
	it("strips the == pin operator from a real registry-sourced entry's version", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pipenv/Pipfile.lock"), "utf8");
		const parsed = parsePipfileLock(text, "Pipfile.lock", "requests", context());
		expect(parsed).toEqual([
			{ version: "2.31.0", evidence: { manager: "pipenv", lockfile: "Pipfile.lock", locator: "requests", kind: "registry", directSource: null, commit: null } },
		]);
	});

	it("searches both the default and develop sections", () => {
		const text = JSON.stringify({ _meta: {}, default: {}, develop: { "dev-only": { version: "==1.0.0" } } });
		expect(parsePipfileLock(text, "Pipfile.lock", "dev-only", context())).toEqual([
			{ version: "1.0.0", evidence: { manager: "pipenv", lockfile: "Pipfile.lock", locator: "dev-only", kind: "registry", directSource: null, commit: null } },
		]);
	});

	it("classifies a git-sourced entry as direct-vcs, using its own ref as the version identity when no semver is declared", () => {
		const text = JSON.stringify({ _meta: {}, default: { "git-dep": { git: "https://github.com/example/git-dep.git", ref: "abcdef1" } }, develop: {} });
		expect(parsePipfileLock(text, "Pipfile.lock", "git-dep", context())).toEqual([
			{
				version: "abcdef1",
				evidence: {
					manager: "pipenv",
					lockfile: "Pipfile.lock",
					locator: "git-dep",
					kind: "direct-vcs",
					directSource: "https://github.com/example/git-dep.git",
					commit: "abcdef1",
				},
			},
		]);
	});

	it("classifies a path-sourced editable entry with a synthetic 'local' version identity", () => {
		const text = JSON.stringify({ _meta: {}, default: { "local-dep": { path: "./local-dep", editable: true } }, develop: {} });
		expect(parsePipfileLock(text, "Pipfile.lock", "local-dep", context())).toEqual([
			{
				version: "local",
				evidence: { manager: "pipenv", lockfile: "Pipfile.lock", locator: "local-dep", kind: "editable", directSource: "./local-dep", commit: null },
			},
		]);
	});

	it("normalizes PEP 503 name variants", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pipenv/Pipfile.lock"), "utf8");
		expect(parsePipfileLock(text, "Pipfile.lock", "Requests", context())).toHaveLength(1);
	});

	it("returns no evidence for a package the lockfile never mentions", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pipenv/Pipfile.lock"), "utf8");
		expect(parsePipfileLock(text, "Pipfile.lock", "does-not-exist", context())).toEqual([]);
	});
});
