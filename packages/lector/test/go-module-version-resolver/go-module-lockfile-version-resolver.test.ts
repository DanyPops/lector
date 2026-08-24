import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoModuleLockfileVersionResolver } from "../../src/go-module-version-resolver/go-module-lockfile-version-resolver.ts";
import type { InstalledGoModuleVersionOutcome } from "../../src/go-module-version-resolver/installed-go-module.ts";
import { type GoReferenceFixture, materializeGoReferenceFixture } from "../support/go-reference-fixture.ts";

const BOUNDS = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxDiagnostics: 20,
	maxCandidates: 20,
	maxEvidencePerVersion: 20,
	maxWorkspaceModules: 20,
};

let fixture: GoReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

function projectWithGoMod(snippet: string): string {
	fixture = materializeGoReferenceFixture();
	copyFileSync(join(fixture.root, "locks", snippet), join(fixture.root, "go.mod"));
	return fixture.root;
}

function versions(outcome: InstalledGoModuleVersionOutcome): string[] {
	return outcome.status === "ambiguous" ? outcome.candidates.map(({ version }) => version) : [];
}

describe("GoModuleLockfileVersionResolver", () => {
	it("resolves a plain registry-style require with its go.sum checksum attached", async () => {
		const root = projectWithGoMod("pseudo-version.go.mod.snippet");
		rmSync(join(root, "vendor"), { recursive: true, force: true });
		writeFileSync(join(root, "go.sum"), "example.com/fixturedep v0.0.0-20240102030405-abcdef123456 h1:REALHASH=\n");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "example.com/fixturedep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.version).toBe("v0.0.0-20240102030405-abcdef123456");
		expect(result.evidence[0]).toMatchObject({ kind: "module-path", commit: "abcdef123456", checksum: "h1:REALHASH=" });
	});

	it("resolves a local-path replace, reporting no fetchable source and no checksum", async () => {
		const root = projectWithGoMod("replace-directive.go.mod.snippet");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "example.com/fixturedep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({ kind: "local-replace", directSource: "../local-fixturedep", commit: null, checksum: null });
	});

	it("resolves a direct-VCS replace naming a different module path at an exact commit", async () => {
		const root = projectWithGoMod("direct-vcs-dependency.go.mod.snippet");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "example.com/vcs-dep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({
			kind: "vcs-replace",
			directSource: "github.com/example/vcs-dep",
			commit: "abcdef1234567890abcdef1234567890abcdef12",
		});
	});

	it("resolves a private module with no go.sum entry -- absent checksum, not a mismatch", async () => {
		const root = projectWithGoMod("private-module.go.mod.snippet");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "git.internal.example/team/private-module", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({ kind: "module-path", checksum: null });
	});

	it("reports checksum-mismatch when go.sum itself declares two different hashes for the same module@version", async () => {
		const root = projectWithGoMod("pseudo-version.go.mod.snippet");
		copyFileSync(join(root, "locks/checksum-mismatch.go.sum.snippet"), join(root, "go.sum"));
		writeFileSync(join(root, "go.mod"), "module fixture.lector.invalid/gomod-reference\n\ngo 1.22\n\nrequire example.com/fixturedep v1.2.3\n");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "example.com/fixturedep", requestedVersion: null },
			BOUNDS,
		);
		expect(result).toEqual({ status: "unavailable", code: "checksum-mismatch", manifest: "go.sum" });
	});

	it("resolves an exact version from vendor/modules.txt when no go.mod require matches", async () => {
		fixture = materializeGoReferenceFixture();
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, modulePath: "example.com/fixturedep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.version).toBe("v1.2.3");
		expect(result.evidence.some((entry) => entry.manifest === "vendor/modules.txt")).toBe(true);
	});

	it("consults a go.work member module's own go.mod, not just the workspace root's", async () => {
		fixture = materializeGoReferenceFixture();
		writeFileSync(join(fixture.root, "go.mod"), "module fixture.lector.invalid/gomod-reference\n\ngo 1.22\n");
		writeFileSync(
			join(fixture.root, "modules/nested/go.mod"),
			"module fixture.lector.invalid/nested\n\ngo 1.22\n\nrequire example.com/nested-only-dep v3.0.0\n",
		);
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, modulePath: "example.com/nested-only-dep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.version).toBe("v3.0.0");
		expect(result.evidence[0]?.manifest).toBe("modules/nested/go.mod");
	});

	it("reports two different workspace members requiring different versions as ambiguous", async () => {
		fixture = materializeGoReferenceFixture();
		writeFileSync(
			join(fixture.root, "go.mod"),
			"module fixture.lector.invalid/gomod-reference\n\ngo 1.22\n\nrequire example.com/workspace-ambiguous-dep v1.0.0\n",
		);
		writeFileSync(
			join(fixture.root, "modules/nested/go.mod"),
			"module fixture.lector.invalid/nested\n\ngo 1.22\n\nrequire example.com/workspace-ambiguous-dep v2.0.0\n",
		);
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, modulePath: "example.com/workspace-ambiguous-dep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("ambiguous");
		expect(versions(result)).toEqual(["v1.0.0", "v2.0.0"]);
	});

	it("reports manifest-not-found when there is no go.mod at the project root", async () => {
		fixture = materializeGoReferenceFixture();
		rmSync(join(fixture.root, "go.mod"));
		rmSync(join(fixture.root, "vendor"), { recursive: true, force: true });
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, modulePath: "example.com/fixturedep", requestedVersion: null },
			BOUNDS,
		);
		expect(result).toEqual({ status: "unavailable", code: "manifest-not-found" });
	});

	it("reports module-not-found when go.mod exists but never mentions the module", async () => {
		const root = projectWithGoMod("pseudo-version.go.mod.snippet");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "example.com/does-not-exist", requestedVersion: null },
			BOUNDS,
		);
		expect(result).toEqual({ status: "unavailable", code: "module-not-found" });
	});

	it("reports version-not-found for a requestedVersion go.mod never records", async () => {
		const root = projectWithGoMod("pseudo-version.go.mod.snippet");
		const result = await new GoModuleLockfileVersionResolver().resolve(
			{ projectRoot: root, modulePath: "example.com/fixturedep", requestedVersion: "v9.9.9" },
			BOUNDS,
		);
		expect(result).toEqual({ status: "unavailable", code: "version-not-found" });
	});
});
