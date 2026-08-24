import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledCrateVersionOutcome } from "../../src/rust-crate-version-resolver/installed-crate.ts";
import { RustCargoLockVersionResolver } from "../../src/rust-crate-version-resolver/rust-cargo-lock-version-resolver.ts";
import { materializeRustReferenceFixture, type RustReferenceFixture } from "../support/rust-reference-fixture.ts";

const BOUNDS = { maxManifestBytes: 1_000_000, maxManifestEntries: 10_000, maxDiagnostics: 20, maxCandidates: 20, maxEvidencePerVersion: 20 };

let fixture: RustReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

function projectWithLock(lockSnippet: string, tomlSnippet?: string): string {
	fixture = materializeRustReferenceFixture();
	rmSync(join(fixture.root, "Cargo.lock"));
	copyFileSync(join(fixture.root, "locks", lockSnippet), join(fixture.root, "Cargo.lock"));
	if (tomlSnippet) copyFileSync(join(fixture.root, "locks", tomlSnippet), join(fixture.root, "Cargo.toml"));
	return fixture.root;
}

function projectWithToml(tomlSnippet: string): string {
	fixture = materializeRustReferenceFixture();
	copyFileSync(join(fixture.root, "locks", tomlSnippet), join(fixture.root, "Cargo.toml"));
	return fixture.root;
}

function versions(outcome: InstalledCrateVersionOutcome): string[] {
	return outcome.status === "ambiguous" ? outcome.candidates.map(({ version }) => version) : [];
}

describe("RustCargoLockVersionResolver", () => {
	it("resolves a real workspace-local crate with no source at all", async () => {
		fixture = materializeRustReferenceFixture();
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: fixture.root, crateName: "contracts", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.version).toBe("0.1.0");
		expect(result.evidence[0]).toMatchObject({ kind: "path" });
	});

	it("resolves a renamed dependency to its own real crate name via Cargo.toml", async () => {
		const root = projectWithToml("renamed-dependency.Cargo.toml.snippet");
		writeFileSync(
			join(root, "Cargo.lock"),
			'version = 4\n\n[[package]]\nname = "serde_json"\nversion = "1.0.100"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aaaa"\n',
		);
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: root, crateName: "json", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.version).toBe("1.0.100");
		expect(result.evidence[0]).toMatchObject({ kind: "registry", realName: "serde_json", checksum: "aaaa" });
	});

	it("resolves an alternate-registry dependency with its own configured index URL", async () => {
		fixture = materializeRustReferenceFixture();
		copyFileSync(join(fixture.root, "locks/alternate-registry.Cargo.toml.snippet"), join(fixture.root, "Cargo.toml"));
		writeFileSync(
			join(fixture.root, "Cargo.lock"),
			'version = 4\n\n[[package]]\nname = "internal-crate"\nversion = "0.3.0"\nsource = "registry+https://crates.internal.example/index"\nchecksum = "bbbb"\n',
		);
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: fixture.root, crateName: "internal-crate", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({ kind: "registry", registryUrl: "https://crates.internal.example/index" });
	});

	it("resolves a git dependency directly from Cargo.toml's own rev when Cargo.lock has no matching entry", async () => {
		const root = projectWithToml("git-dependency.Cargo.toml.snippet");
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: root, crateName: "fixturedep", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({
			kind: "git",
			directSource: "https://github.com/example/fixturedep.git",
			commit: "abcdef1234567890abcdef1234567890abcdef12",
		});
	});

	it("resolves a git dependency pinned by tag, with no known commit yet", async () => {
		const root = projectWithToml("mismatched-tag.Cargo.toml.snippet");
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: root, crateName: "fixturedep", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({ kind: "git", gitRef: "v9.9.9", commit: null });
	});

	it("reports checksum-mismatch when Cargo.lock itself declares two different checksums for the same name@version", async () => {
		const root = projectWithLock("checksum-mismatch.Cargo.lock.snippet");
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: root, crateName: "fixturedep", requestedVersion: null }, BOUNDS);
		expect(result).toEqual({ status: "unavailable", code: "checksum-mismatch", manifest: "Cargo.lock" });
	});

	it("resolves a yanked-with-missing-metadata entry with a null checksum, not a mismatch", async () => {
		const root = projectWithLock("yanked-missing-metadata.Cargo.lock.snippet");
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: root, crateName: "yanked-dep", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.evidence[0]).toMatchObject({ checksum: null });
	});

	it("reports manifest-not-found when neither Cargo.toml nor Cargo.lock exists", async () => {
		fixture = materializeRustReferenceFixture();
		rmSync(join(fixture.root, "Cargo.lock"));
		rmSync(join(fixture.root, "Cargo.toml"));
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: fixture.root, crateName: "contracts", requestedVersion: null }, BOUNDS);
		expect(result).toEqual({ status: "unavailable", code: "manifest-not-found" });
	});

	it("reports crate-not-found when Cargo.lock exists but never mentions the crate", async () => {
		fixture = materializeRustReferenceFixture();
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: fixture.root, crateName: "does-not-exist", requestedVersion: null }, BOUNDS);
		expect(result).toEqual({ status: "unavailable", code: "crate-not-found" });
	});

	it("reports two duplicate-name entries at different versions as ambiguous", async () => {
		fixture = materializeRustReferenceFixture();
		writeFileSync(
			join(fixture.root, "Cargo.lock"),
			'version = 4\n\n[[package]]\nname = "dup"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aaaa"\n\n[[package]]\nname = "dup"\nversion = "2.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "bbbb"\n',
		);
		const result = await new RustCargoLockVersionResolver().resolve({ projectRoot: fixture.root, crateName: "dup", requestedVersion: null }, BOUNDS);
		expect(result.status).toBe("ambiguous");
		expect(versions(result)).toEqual(["1.0.0", "2.0.0"]);
	});
});
