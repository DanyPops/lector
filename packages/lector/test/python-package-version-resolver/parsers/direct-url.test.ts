import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDirectUrlJson } from "../../../src/python-package-version-resolver/parsers/direct-url.ts";
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

describe("parseDirectUrlJson", () => {
	it("classifies a real VCS-sourced direct_url.json (PEP 610) as direct-vcs with its own exact commit", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pip/direct_url.json"), "utf8");
		expect(parseDirectUrlJson(text, context())).toEqual({
			kind: "direct-vcs",
			directSource: "https://github.com/example/editable-dep.git",
			commit: "abcdef1234567890abcdef1234567890abcdef12",
		});
	});

	it("classifies a real editable local-path direct_url.json as editable", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/pip/direct_url.editable.json"), "utf8");
		expect(parseDirectUrlJson(text, context())).toEqual({ kind: "editable", directSource: "file:///home/dev/local-editable-dep", commit: null });
	});

	it("classifies a plain URL install (no vcs_info, no dir_info.editable) as direct-url", () => {
		const text = JSON.stringify({ url: "https://files.pythonhosted.org/packages/widget-1.0.0-py3-none-any.whl" });
		expect(parseDirectUrlJson(text, context())).toEqual({
			kind: "direct-url",
			directSource: "https://files.pythonhosted.org/packages/widget-1.0.0-py3-none-any.whl",
			commit: null,
		});
	});

	it("returns null for a malformed direct_url.json missing its required url field", () => {
		expect(parseDirectUrlJson("{}", context())).toBeNull();
	});
});
