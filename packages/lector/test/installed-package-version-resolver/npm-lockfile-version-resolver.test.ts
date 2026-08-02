import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { InstalledPackageVersionOutcome } from "../../src/installed-package-version-resolver/installed-package-version.ts";
import {
	InvalidInstalledPackageVersionRequest,
	NpmLockfileVersionResolver,
} from "../../src/installed-package-version-resolver/npm-lockfile-version-resolver.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "../support/typescript-reference-fixture.ts";

const BOUNDS = {
	maxManifestBytes: 1_000_000,
	maxManifestEntries: 10_000,
	maxManifestNesting: 64,
	maxWorkspaces: 100,
	maxDiagnostics: 20,
	maxCandidates: 20,
	maxEvidencePerVersion: 20,
} as const;
let fixture: TypeScriptReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

function projectWithLock(relativeLockPath: string): string {
	fixture = materializeTypeScriptReferenceFixture();
	copyFileSync(join(fixture.root, relativeLockPath), join(fixture.root, basename(relativeLockPath)));
	return fixture.root;
}

function versions(outcome: InstalledPackageVersionOutcome): string[] {
	return outcome.status === "ambiguous" ? outcome.candidates.map(({ version }) => version) : [];
}

describe("NpmLockfileVersionResolver", () => {
	for (const [manager, lockfile] of [
		["npm", "locks/npm/package-lock.json"],
		["pnpm", "locks/pnpm/pnpm-lock.yaml"],
		["yarn", "locks/yarn/yarn.lock"],
		["bun", "locks/bun/bun.lock"],
	] as const) {
		it(`reports duplicate installed versions from ${manager} as ambiguous`, async () => {
			const root = projectWithLock(lockfile);
			const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: root, packageName: "@fixture/dependency", requestedVersion: null }, BOUNDS);

			expect(result.status).toBe("ambiguous");
			expect(versions(result)).toEqual(["1.2.3", "2.0.0"]);
		});

		it(`uses an explicit ${manager} version instead of choosing arbitrarily`, async () => {
			const root = projectWithLock(lockfile);
			const result = await new NpmLockfileVersionResolver().resolve(
				{ projectRoot: root, packageName: "@fixture/dependency", requestedVersion: "1.2.3" },
				BOUNDS,
			);

			expect(result.status).toBe("resolved");
			if (result.status === "resolved") {
				expect(result.version).toBe("1.2.3");
				expect(result.evidence.some((entry) => entry.manager === manager)).toBe(true);
			}
		});
	}

	it("supports package-lock v2 records", async () => {
		const root = projectWithLock("locks/npm/package-lock.json");
		const path = join(root, "package-lock.json");
		writeFileSync(path, readFileSync(path, "utf8").replace('"lockfileVersion": 3', '"lockfileVersion": 2'));

		const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: root, packageName: "@fixture/dependency", requestedVersion: "1.2.3" }, BOUNDS);

		expect(result.status).toBe("resolved");
	});

	it("honors npm-shrinkwrap.json with package-lock v3 semantics", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		copyFileSync(join(fixture.root, "locks/npm/package-lock.json"), join(fixture.root, "npm-shrinkwrap.json"));
		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: "2.0.0" },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") expect(result.evidence[0]?.lockfile).toBe("npm-shrinkwrap.json");
	});

	it("parses modern Yarn resolutions through the maintained Yarn parser", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(
			join(fixture.root, "yarn.lock"),
			'__metadata:\n  version: 8\n\n"@fixture/dependency@npm:1.2.3":\n  version: 1.2.3\n  resolution: "@fixture/dependency@npm:1.2.3"\n',
		);
		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") expect(result.version).toBe("1.2.3");
	});

	it("parses Bun JSONC comments and trailing commas", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(
			join(fixture.root, "bun.lock"),
			'{\n// fixture\n"lockfileVersion": 1,\n"packages": {"@fixture/dependency": ["@fixture/dependency@1.2.3", "", {}, "sha512-fixture"],},\n}\n',
		);
		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: null },
			BOUNDS,
		);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") expect(result.version).toBe("1.2.3");
	});

	it("resolves an npm workspace link from its target package record", async () => {
		const root = projectWithLock("locks/npm/package-lock.json");
		const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: root, packageName: "@fixture/contracts", requestedVersion: null }, BOUNDS);

		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.version).toBe("1.0.0");
			expect(result.evidence[0]?.workspace).toBe(true);
		}
	});

	for (const [manager, lockfile] of [
		["pnpm", "locks/pnpm/pnpm-lock.yaml"],
		["bun", "locks/bun/bun.lock"],
	] as const) {
		it(`resolves an exact ${manager} workspace package version`, async () => {
			const root = projectWithLock(lockfile);
			const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: root, packageName: "@fixture/contracts", requestedVersion: null }, BOUNDS);

			expect(result.status).toBe("resolved");
			if (result.status === "resolved") {
				expect(result.version).toBe("1.0.0");
				expect(result.evidence.some((entry) => entry.manager === manager && entry.workspace)).toBe(true);
			}
		});
	}

	it("resolves a pnpm workspace-only lock without a packages table", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  packages/contracts: {}\n");

		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/contracts", requestedVersion: null },
			BOUNDS,
		);

		expect(result.status).toBe("resolved");
		if (result.status === "resolved") expect(result.version).toBe("1.0.0");
	});

	it("rejects workspace paths that escape the project root", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  ../outside: {}\npackages: {}\n");

		const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: fixture.root, packageName: "outside", requestedVersion: null }, BOUNDS);

		expect(result).toEqual({ status: "unavailable", code: "corrupt-lockfile", lockfile: "pnpm-lock.yaml" });
	});

	it("resolves a modern Yarn workspace locator through its package manifest", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(
			join(fixture.root, "yarn.lock"),
			'__metadata:\n  version: 8\n\n"@fixture/contracts@workspace:packages/contracts":\n  version: 0.0.0-use.local\n  resolution: "@fixture/contracts@workspace:packages/contracts"\n',
		);

		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/contracts", requestedVersion: null },
			BOUNDS,
		);

		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.version).toBe("1.0.0");
			expect(result.evidence[0]?.workspace).toBe(true);
		}
	});

	it("rejects invalid requests and bounds before reading a lockfile", () => {
		const localFixture = materializeTypeScriptReferenceFixture();
		fixture = localFixture;
		const resolver = new NpmLockfileVersionResolver();

		expect(() => resolver.resolve({ projectRoot: localFixture.root, packageName: "", requestedVersion: null }, BOUNDS)).toThrow(
			InvalidInstalledPackageVersionRequest,
		);
		expect(() =>
			resolver.resolve({ projectRoot: localFixture.root, packageName: "@fixture/dependency", requestedVersion: null }, { ...BOUNDS, maxCandidates: 0 }),
		).toThrow(InvalidInstalledPackageVersionRequest);
	});

	it("returns package-not-found instead of inventing a version", async () => {
		const root = projectWithLock("locks/npm/package-lock.json");
		const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: root, packageName: "does-not-exist", requestedVersion: null }, BOUNDS);

		expect(result).toEqual({ status: "unavailable", code: "package-not-found" });
	});

	it("distinguishes a missing lockfile from an absent explicit version", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const resolver = new NpmLockfileVersionResolver();

		expect(await resolver.resolve({ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: null }, BOUNDS)).toEqual({
			status: "unavailable",
			code: "lockfile-not-found",
		});
		copyFileSync(join(fixture.root, "locks/npm/package-lock.json"), join(fixture.root, "package-lock.json"));
		expect(await resolver.resolve({ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: "9.9.9" }, BOUNDS)).toEqual({
			status: "unavailable",
			code: "version-not-found",
		});
	});

	it("rejects malformed lock data explicitly", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(join(fixture.root, "package-lock.json"), "{ broken");

		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: null },
			BOUNDS,
		);
		expect(result).toEqual({ status: "unavailable", code: "corrupt-lockfile", lockfile: "package-lock.json" });
	});

	for (const [lockfile, content] of [
		["package-lock.json", '{"lockfileVersion":1,"packages":{}}'],
		["pnpm-lock.yaml", "lockfileVersion: '99.0'\npackages: {}\n"],
		["yarn.lock", '__metadata:\n  version: 999\n\n"fixture@npm:1.0.0":\n  version: 1.0.0\n'],
		["bun.lock", '{"lockfileVersion":99,"packages":{}}'],
	] as const) {
		it(`rejects an unsupported ${lockfile} version explicitly`, async () => {
			fixture = materializeTypeScriptReferenceFixture();
			writeFileSync(join(fixture.root, lockfile), content);

			const result = await new NpmLockfileVersionResolver().resolve({ projectRoot: fixture.root, packageName: "fixture", requestedVersion: null }, BOUNDS);

			expect(result).toEqual({ status: "unavailable", code: "unsupported-lockfile", lockfile });
		});
	}

	it("returns an explicit unsupported result for legacy binary bun.lockb", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(join(fixture.root, "bun.lockb"), Buffer.from([0, 1, 2, 3]));

		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: null },
			BOUNDS,
		);
		expect(result).toEqual({ status: "unavailable", code: "unsupported-lockfile", lockfile: "bun.lockb" });
	});

	it("bounds evidence for one version and reports truncation", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		for (const relativePath of ["locks/npm/package-lock.json", "locks/pnpm/pnpm-lock.yaml", "locks/yarn/yarn.lock", "locks/bun/bun.lock"]) {
			copyFileSync(join(fixture.root, relativePath), join(fixture.root, basename(relativePath)));
		}

		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: fixture.root, packageName: "@fixture/dependency", requestedVersion: "1.2.3" },
			{ ...BOUNDS, maxEvidencePerVersion: 1 },
		);
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.evidence).toHaveLength(1);
			expect(result.evidenceTruncated).toBe(true);
		}
	});

	it("bounds ambiguous candidates and reports truncation", async () => {
		const root = projectWithLock("locks/npm/package-lock.json");
		const result = await new NpmLockfileVersionResolver().resolve(
			{ projectRoot: root, packageName: "@fixture/dependency", requestedVersion: null },
			{ ...BOUNDS, maxCandidates: 1 },
		);

		expect(result.status).toBe("ambiguous");
		if (result.status === "ambiguous") {
			expect(result.candidates).toHaveLength(1);
			expect(result.truncated).toBe(true);
		}
	});

	it("enforces manifest byte and entry bounds before returning partial evidence", async () => {
		const root = projectWithLock("locks/npm/package-lock.json");
		const resolver = new NpmLockfileVersionResolver();

		expect(
			await resolver.resolve({ projectRoot: root, packageName: "@fixture/dependency", requestedVersion: null }, { ...BOUNDS, maxManifestBytes: 10 }),
		).toEqual({ status: "oversized", resource: "manifest-bytes", limit: 10 });
		expect(
			await resolver.resolve({ projectRoot: root, packageName: "@fixture/dependency", requestedVersion: null }, { ...BOUNDS, maxManifestEntries: 1 }),
		).toEqual({ status: "oversized", resource: "manifest-entries", limit: 1 });
	});

	it("bounds manifest nesting, workspaces, and parser diagnostics", async () => {
		const resolver = new NpmLockfileVersionResolver();
		const root = projectWithLock("locks/pnpm/pnpm-lock.yaml");
		expect(await resolver.resolve({ projectRoot: root, packageName: "@fixture/contracts", requestedVersion: null }, { ...BOUNDS, maxWorkspaces: 1 })).toEqual({
			status: "oversized",
			resource: "workspaces",
			limit: 1,
		});

		fixture?.dispose();
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(join(fixture.root, "bun.lock"), '{"lockfileVersion":1,"packages":{},"nested":{"a":{"b":{"c":true}}}}');
		expect(await resolver.resolve({ projectRoot: fixture.root, packageName: "fixture", requestedVersion: null }, { ...BOUNDS, maxManifestNesting: 3 })).toEqual(
			{ status: "oversized", resource: "manifest-nesting", limit: 3 },
		);

		writeFileSync(join(fixture.root, "bun.lock"), '{"lockfileVersion":1,"packages":{,,,,,,,,}}');
		expect(await resolver.resolve({ projectRoot: fixture.root, packageName: "fixture", requestedVersion: null }, { ...BOUNDS, maxDiagnostics: 1 })).toEqual({
			status: "oversized",
			resource: "diagnostics",
			limit: 1,
		});
	});
});
