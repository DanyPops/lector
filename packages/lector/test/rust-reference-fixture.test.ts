import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LocalGit } from "../src/git/local-git.ts";
import { resolveWorkspacePath } from "../src/workspace/resolve-workspace-path.ts";
import {
	materializeRustReferenceFixture,
	materializeRustReferenceGitFixture,
	type RustReferenceFixture,
	readRustReferenceManifest,
} from "./support/rust-reference-fixture.ts";

let fixture: RustReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("Rust reference fixture", () => {
	it("materializes an isolated workspace with every declared source and package-resolution case", () => {
		fixture = materializeRustReferenceFixture();
		const manifest = readRustReferenceManifest(fixture.root);

		for (const path of manifest.requiredPaths) expect(existsSync(join(fixture.root, path))).toBe(true);
		expect(manifest.languages).toEqual(["rust"]);
		expect(manifest.packageManagers).toEqual(["cargo"]);
		expect(manifest.expectedSymbols.map(({ name }) => name)).toEqual(
			expect.arrayContaining(["PaymentProcessor", "StripeProcessor", "run_checkout", "nested_marker"]),
		);
	});

	it("copies source so mutation tests cannot corrupt the committed fixture", () => {
		fixture = materializeRustReferenceFixture();
		const relativePath = "contracts/src/payment.rs";
		const materializedPath = join(fixture.root, relativePath);
		const committedPath = join(fixture.sourceRoot, relativePath);
		const original = readFileSync(committedPath, "utf8");

		writeFileSync(materializedPath, "pub const CHANGED: bool = true;\n");

		expect(readFileSync(committedPath, "utf8")).toBe(original);
	});

	it("resolves the nested crate to the workspace root -- a Cargo workspace member, unlike Python/Go's separate nested projects", () => {
		fixture = materializeRustReferenceFixture();
		const nestedSourceFile = join(fixture.root, "crates/nested/src/lib.rs");

		const resolved = resolveWorkspacePath({
			strategy: "language-project-root",
			path: dirname(nestedSourceFile),
			fallback: "given-directory",
			extension: ".rs",
		});

		// Cargo workspace members have no own root marker below the workspace's own Cargo.toml
		// (crates/nested/Cargo.toml matches "Cargo.toml" too, though) -- nearestProjectRoot finds
		// the nearest one, which for a workspace member IS its own package manifest.
		expect(resolved).toEqual({ found: true, root: join(fixture.root, "crates/nested") });
	});

	it("materializes bounded Git history with a symbol and path rename", async () => {
		const gitFixture = materializeRustReferenceGitFixture();
		fixture = gitFixture;
		const git = new LocalGit(gitFixture.root);

		const log = await git.log(2);
		const diff = await git.diff(gitFixture.baselineRef, 20_000);

		expect(log.map(({ message }) => message)).toEqual(["rename order contract", "baseline payment contract"]);
		expect(diff.truncated).toBe(false);
		expect(diff.diff).toContain("purchase.rs");
		expect(diff.diff).toContain("PurchaseOrder");
	});
});
