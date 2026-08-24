import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUvLock } from "../../../src/python-package-version-resolver/parsers/uv-lock.ts";
import { PythonResolutionContext } from "../../../src/python-package-version-resolver/resolution-context.ts";
import { readPythonReferenceManifest } from "../../support/python-reference-fixture.ts";

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

describe("parseUvLock", () => {
	it("resolves a real registry-sourced package's version", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/uv/uv.lock"), "utf8");
		const parsed = parseUvLock(text, "uv.lock", "requests", context());
		expect(parsed).toEqual([
			{ version: "2.31.0", evidence: { manager: "uv", lockfile: "uv.lock", locator: "requests", kind: "registry", directSource: null, commit: null } },
		]);
	});

	it("marks an editable-sourced package with its own local path, not a registry version", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/uv/uv.lock"), "utf8");
		const parsed = parseUvLock(text, "uv.lock", "editable-dep", context());
		expect(parsed).toEqual([
			{
				version: "0.1.0",
				evidence: { manager: "uv", lockfile: "uv.lock", locator: "editable-dep", kind: "editable", directSource: "../local-editable-dep", commit: null },
			},
		]);
	});

	it("skips the virtual root project entry entirely -- it is the project itself, not an installed dependency", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/uv/uv.lock"), "utf8");
		expect(parseUvLock(text, "uv.lock", "python-reference", context())).toEqual([]);
	});

	it("normalizes PEP 503 name variants against the same entry", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/uv/uv.lock"), "utf8");
		expect(parseUvLock(text, "uv.lock", "Requests", context())).toHaveLength(1);
		expect(parseUvLock(text, "uv.lock", "Editable_Dep", context())).toHaveLength(1);
	});

	it("returns no evidence for a package the lockfile never mentions", () => {
		const text = readFileSync(join(FIXTURE_ROOT, "locks/uv/uv.lock"), "utf8");
		expect(parseUvLock(text, "uv.lock", "does-not-exist", context())).toEqual([]);
	});

	it("real fixture file exists and is readable as documented in fixture.json", () => {
		const manifest = readPythonReferenceManifest();
		expect(manifest.requiredPaths).toContain("locks/uv/uv.lock");
	});
});
