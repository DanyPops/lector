import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequirementsTxt } from "../../../src/python-package-version-resolver/parsers/requirements-txt.ts";
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

describe("parseRequirementsTxt", () => {
	it("resolves an exact == pin from the real fixture file", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pip/requirements.txt"), "utf8");
		const parsed = parseRequirementsTxt(text, "requirements.txt", "requests", context());
		expect(parsed).toEqual([
			{
				version: "2.31.0",
				evidence: { manager: "pip", lockfile: "requirements.txt", locator: "requests==2.31.0", kind: "registry", directSource: null, commit: null },
			},
		]);
	});

	it("parses a real -e git+ editable VCS line, extracting the egg name and pinned ref", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pip/requirements.txt"), "utf8");
		const parsed = parseRequirementsTxt(text, "requirements.txt", "editable-dep", context());
		expect(parsed).toEqual([
			{
				version: "abcdef1",
				evidence: {
					manager: "pip",
					lockfile: "requirements.txt",
					locator: "-e git+https://github.com/example/editable-dep.git@abcdef1#egg=editable-dep",
					kind: "editable",
					directSource: "git+https://github.com/example/editable-dep.git",
					commit: "abcdef1",
				},
			},
		]);
	});

	it("parses PEP 508 direct-reference syntax (name @ git+URL) as direct-vcs, not editable", () => {
		const text = "widget @ git+https://github.com/example/widget.git@v1.0.0\n";
		expect(parseRequirementsTxt(text, "requirements.txt", "widget", context())).toEqual([
			{
				version: "v1.0.0",
				evidence: {
					manager: "pip",
					lockfile: "requirements.txt",
					locator: "widget @ git+https://github.com/example/widget.git@v1.0.0",
					kind: "direct-vcs",
					directSource: "git+https://github.com/example/widget.git",
					commit: "v1.0.0",
				},
			},
		]);
	});

	it("ignores a range/non-exact constraint -- it never tells us the actual installed version", () => {
		expect(parseRequirementsTxt("requests>=2.0\n", "requirements.txt", "requests", context())).toEqual([]);
	});

	it("strips extras and inline comments from an exact pin", () => {
		const parsed = parseRequirementsTxt("requests[security]==2.31.0  # pinned deliberately\n", "requirements.txt", "requests", context());
		expect(parsed).toEqual([
			{
				version: "2.31.0",
				evidence: { manager: "pip", lockfile: "requirements.txt", locator: "requests[security]==2.31.0", kind: "registry", directSource: null, commit: null },
			},
		]);
	});

	it("skips comment and blank lines without error", () => {
		expect(parseRequirementsTxt("# a real comment\n\nrequests==2.31.0\n", "requirements.txt", "requests", context())).toHaveLength(1);
	});

	it("normalizes PEP 503 name variants", () => {
		expect(parseRequirementsTxt("Editable_Dep==1.0.0\n", "requirements.txt", "editable-dep", context())).toHaveLength(1);
	});

	it("returns no evidence for a package the file never mentions", () => {
		expect(parseRequirementsTxt("requests==2.31.0\n", "requirements.txt", "does-not-exist", context())).toEqual([]);
	});
});
