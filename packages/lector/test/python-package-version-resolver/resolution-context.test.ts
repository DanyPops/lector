import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestResourceLimitExceeded } from "../../src/python-package-version-resolver/limits.ts";
import { PythonResolutionContext } from "../../src/python-package-version-resolver/resolution-context.ts";

const BOUNDS = { maxManifestBytes: 1_000, maxManifestEntries: 1_000, maxManifestNesting: 5, maxDiagnostics: 20, maxCandidates: 20, maxEvidencePerVersion: 20 };

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function temp(): string {
	root = mkdtempSync(join(tmpdir(), "lector-python-resolution-context-"));
	return root;
}

describe("PythonResolutionContext", () => {
	it("reads a real project file within bounds", () => {
		const dir = temp();
		writeFileSync(join(dir, "requirements.txt"), "requests==2.31.0\n");
		const context = new PythonResolutionContext(dir, BOUNDS);
		expect(context.readProjectFile("requirements.txt")).toBe("requests==2.31.0\n");
	});

	it("rejects a file larger than the manifest-bytes bound", () => {
		const dir = temp();
		writeFileSync(join(dir, "requirements.txt"), "x".repeat(2_000));
		const context = new PythonResolutionContext(dir, BOUNDS);
		expect(() => context.readProjectFile("requirements.txt")).toThrow(ManifestResourceLimitExceeded);
	});

	it("rejects a relative path that escapes the project root", () => {
		const dir = temp();
		const context = new PythonResolutionContext(dir, BOUNDS);
		expect(() => context.readProjectFile("../outside.txt")).toThrow();
	});

	it("rejects a symlink that escapes the project root", () => {
		const dir = temp();
		symlinkSync("/etc/passwd", join(dir, "requirements.txt"));
		const context = new PythonResolutionContext(dir, BOUNDS);
		expect(() => context.readProjectFile("requirements.txt")).toThrow();
	});

	it("parses real JSON and bounds its nesting depth", () => {
		const dir = temp();
		const context = new PythonResolutionContext(dir, BOUNDS);
		expect(context.parseJson('{"a": {"b": 1}}')).toEqual({ a: { b: 1 } });
		expect(() => context.parseJson('{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}')).toThrow(ManifestResourceLimitExceeded);
	});

	it("parses real TOML and bounds its nesting depth", () => {
		const dir = temp();
		const context = new PythonResolutionContext(dir, BOUNDS);
		expect(context.parseToml("[a]\nb = 1\n")).toEqual({ a: { b: 1 } });
		expect(() => context.parseToml("[a.b.c.d.e]\nf = 1\n")).toThrow(ManifestResourceLimitExceeded);
	});

	it("accumulates bytes read across multiple files against one shared budget", () => {
		const dir = temp();
		writeFileSync(join(dir, "a.txt"), "x".repeat(600));
		writeFileSync(join(dir, "b.txt"), "x".repeat(600));
		const context = new PythonResolutionContext(dir, BOUNDS);
		context.readProjectFile("a.txt");
		expect(() => context.readProjectFile("b.txt")).toThrow(ManifestResourceLimitExceeded);
	});
});
