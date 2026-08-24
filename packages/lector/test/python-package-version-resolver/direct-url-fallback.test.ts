import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDirectUrlEvidence } from "../../src/python-package-version-resolver/direct-url-fallback.ts";
import { PythonResolutionContext } from "../../src/python-package-version-resolver/resolution-context.ts";

const FIXTURE_ROOT = join(import.meta.dirname, "../../test/fixtures/python-reference");
const BOUNDS = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxManifestNesting: 64,
	maxDiagnostics: 20,
	maxCandidates: 20,
	maxEvidencePerVersion: 20,
};

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function venvWithDistInfo(distInfoName: string, directUrlFixture: string): string {
	root = mkdtempSync(join(tmpdir(), "lector-python-direct-url-"));
	const distInfo = join(root, ".venv/lib/python3.11/site-packages", `${distInfoName}.dist-info`);
	mkdirSync(distInfo, { recursive: true });
	writeFileSync(join(distInfo, "direct_url.json"), readFileSync(join(FIXTURE_ROOT, "locks/pip", directUrlFixture), "utf8"));
	return root;
}

describe("findDirectUrlEvidence", () => {
	it("finds a real direct_url.json under the conventional .venv/lib/pythonX.Y/site-packages layout, deriving name/version from the dist-info directory name", () => {
		const projectRoot = venvWithDistInfo("editable_dep-0.1.0", "direct_url.json");
		const context = new PythonResolutionContext(projectRoot, BOUNDS);

		const result = findDirectUrlEvidence(projectRoot, "editable-dep", context);

		expect(result).toEqual({
			version: "0.1.0",
			evidence: {
				manager: "pip",
				lockfile: ".venv/lib/python3.11/site-packages/editable_dep-0.1.0.dist-info/direct_url.json",
				locator: "editable_dep-0.1.0.dist-info",
				kind: "direct-vcs",
				directSource: "https://github.com/example/editable-dep.git",
				commit: "abcdef1234567890abcdef1234567890abcdef12",
			},
		});
	});

	it("also finds a real editable local-path install the same way", () => {
		const projectRoot = venvWithDistInfo("local_editable_dep-0.2.0", "direct_url.editable.json");
		const context = new PythonResolutionContext(projectRoot, BOUNDS);

		const result = findDirectUrlEvidence(projectRoot, "local-editable-dep", context);

		expect(result?.evidence.kind).toBe("editable");
		expect(result?.version).toBe("0.2.0");
	});

	it("matches under PEP 503 name normalization -- a dist-info's own underscore-for-hyphen convention", () => {
		const projectRoot = venvWithDistInfo("editable_dep-0.1.0", "direct_url.json");
		const context = new PythonResolutionContext(projectRoot, BOUNDS);
		expect(findDirectUrlEvidence(projectRoot, "Editable.Dep", context)).not.toBeNull();
	});

	it("also finds a plain (non-.venv) venv/ directory layout", () => {
		root = mkdtempSync(join(tmpdir(), "lector-python-direct-url-"));
		const distInfo = join(root, "venv/lib/python3.12/site-packages", "editable_dep-0.1.0.dist-info");
		mkdirSync(distInfo, { recursive: true });
		writeFileSync(join(distInfo, "direct_url.json"), readFileSync(join(FIXTURE_ROOT, "locks/pip/direct_url.json"), "utf8"));
		const context = new PythonResolutionContext(root, BOUNDS);
		expect(findDirectUrlEvidence(root, "editable-dep", context)).not.toBeNull();
	});

	it("returns null when no venv exists at all", () => {
		root = mkdtempSync(join(tmpdir(), "lector-python-direct-url-"));
		const context = new PythonResolutionContext(root, BOUNDS);
		expect(findDirectUrlEvidence(root, "editable-dep", context)).toBeNull();
	});

	it("returns null when the venv exists but the package was never installed there", () => {
		const projectRoot = venvWithDistInfo("editable_dep-0.1.0", "direct_url.json");
		const context = new PythonResolutionContext(projectRoot, BOUNDS);
		expect(findDirectUrlEvidence(projectRoot, "does-not-exist", context)).toBeNull();
	});
});
