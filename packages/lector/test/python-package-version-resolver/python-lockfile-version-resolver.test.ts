import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { InstalledPythonVersionOutcome } from "../../src/python-package-version-resolver/installed-package-version.ts";
import { PythonLockfileVersionResolver } from "../../src/python-package-version-resolver/python-lockfile-version-resolver.ts";
import { materializePythonReferenceFixture, type PythonReferenceFixture } from "../support/python-reference-fixture.ts";

const BOUNDS = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxManifestNesting: 64,
	maxDiagnostics: 20,
	maxCandidates: 20,
	maxEvidencePerVersion: 20,
};
let fixture: PythonReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

function projectWithLock(relativeLockPath: string): string {
	fixture = materializePythonReferenceFixture();
	copyFileSync(join(fixture.root, relativeLockPath), join(fixture.root, basename(relativeLockPath)));
	return fixture.root;
}

function versions(outcome: InstalledPythonVersionOutcome): string[] {
	return outcome.status === "ambiguous" ? outcome.candidates.map(({ version }) => version) : [];
}

describe("PythonLockfileVersionResolver", () => {
	for (const [manager, lockfile] of [
		["uv", "locks/uv/uv.lock"],
		["pipenv", "locks/pipenv/Pipfile.lock"],
	] as const) {
		it(`resolves the exact installed version from ${manager}`, async () => {
			const root = projectWithLock(lockfile);
			const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: root, packageName: "requests", requestedVersion: null }, BOUNDS);

			expect(result.status).toBe("resolved");
			if (result.status === "resolved") {
				expect(result.version).toBe("2.31.0");
				expect(result.evidence.some((entry) => entry.manager === manager)).toBe(true);
			}
		});
	}

	it("resolves requirements.txt's own exact pin", async () => {
		fixture = materializePythonReferenceFixture();
		copyFileSync(join(fixture.root, "locks/pip/requirements.txt"), join(fixture.root, "requirements.txt"));
		const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: fixture.root, packageName: "requests", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") expect(result.version).toBe("2.31.0");
	});

	it("resolves requirements.txt's own editable VCS entry with its pinned ref as evidence", async () => {
		fixture = materializePythonReferenceFixture();
		copyFileSync(join(fixture.root, "locks/pip/requirements.txt"), join(fixture.root, "requirements.txt"));
		const result = await new PythonLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "editable-dep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.version).toBe("abcdef1");
			expect(result.evidence[0]).toMatchObject({ kind: "editable", directSource: "git+https://github.com/example/editable-dep.git" });
		}
	});

	it("reports poetry's own two real versions (main + dev extra) as ambiguous", async () => {
		const root = projectWithLock("locks/poetry/poetry.lock");
		const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: root, packageName: "requests", requestedVersion: null }, BOUNDS);

		expect(result.status).toBe("ambiguous");
		expect(versions(result)).toEqual(["2.31.0", "2.32.3"]);
	});

	it("uses an explicit requestedVersion to disambiguate poetry's two versions", async () => {
		const root = projectWithLock("locks/poetry/poetry.lock");
		const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: root, packageName: "requests", requestedVersion: "2.32.3" }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") expect(result.version).toBe("2.32.3");
	});

	it("falls back to a real venv's own direct_url.json when no lockfile exists at all", async () => {
		fixture = materializePythonReferenceFixture();
		const distInfo = join(fixture.root, ".venv/lib/python3.11/site-packages/editable_dep-0.1.0.dist-info");
		mkdirSync(distInfo, { recursive: true });
		copyFileSync(join(fixture.root, "locks/pip/direct_url.json"), join(distInfo, "direct_url.json"));

		const result = await new PythonLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "editable-dep", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.version).toBe("0.1.0");
			expect(result.evidence[0]?.kind).toBe("direct-vcs");
		}
	});

	it("reports lockfile-not-found when neither a lockfile nor a venv exists", async () => {
		fixture = materializePythonReferenceFixture();
		writeFileSync(join(fixture.root, "unrelated.txt"), "nothing to see here\n");
		const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: fixture.root, packageName: "requests", requestedVersion: null }, BOUNDS);
		expect(result).toEqual({ status: "unavailable", code: "lockfile-not-found" });
	});

	it("reports package-not-found when a real lockfile exists but never mentions the package", async () => {
		const root = projectWithLock("locks/uv/uv.lock");
		const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: root, packageName: "does-not-exist", requestedVersion: null }, BOUNDS);
		expect(result).toEqual({ status: "unavailable", code: "package-not-found" });
	});

	it("reports version-not-found for a requestedVersion the lockfile never records", async () => {
		const root = projectWithLock("locks/uv/uv.lock");
		const result = await new PythonLockfileVersionResolver().resolve({ projectRoot: root, packageName: "requests", requestedVersion: "9.9.9" }, BOUNDS);
		expect(result).toEqual({ status: "unavailable", code: "version-not-found" });
	});
});
