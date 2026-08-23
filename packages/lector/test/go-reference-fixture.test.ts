import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LocalGit } from "../src/git/local-git.ts";
import { resolveWorkspacePath } from "../src/workspace/resolve-workspace-path.ts";
import {
	type GoReferenceFixture,
	materializeGoReferenceFixture,
	materializeGoReferenceGitFixture,
	readGoReferenceManifest,
} from "./support/go-reference-fixture.ts";

let fixture: GoReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("Go reference fixture", () => {
	it("materializes an isolated module with every declared source and package-resolution case", () => {
		fixture = materializeGoReferenceFixture();
		const manifest = readGoReferenceManifest(fixture.root);

		for (const path of manifest.requiredPaths) expect(existsSync(join(fixture.root, path))).toBe(true);
		expect(manifest.languages).toEqual(["go"]);
		expect(manifest.packageManagers).toEqual(["gomod", "goworkspace", "govendor"]);
		expect(manifest.expectedSymbols.map(({ name }) => name)).toEqual(
			expect.arrayContaining(["PaymentProcessor", "StripeProcessor", "RunCheckout", "NestedMarker"]),
		);
	});

	it("copies source so mutation tests cannot corrupt the committed fixture", () => {
		fixture = materializeGoReferenceFixture();
		const relativePath = "contracts/payment.go";
		const materializedPath = join(fixture.root, relativePath);
		const committedPath = join(fixture.sourceRoot, relativePath);
		const original = readFileSync(committedPath, "utf8");

		writeFileSync(materializedPath, "package contracts\n\nvar Changed = true\n");

		expect(readFileSync(committedPath, "utf8")).toBe(original);
	});

	it("resolves the nested go.mod module to itself, not the outer fixture root", () => {
		fixture = materializeGoReferenceFixture();
		const nestedSourceFile = join(fixture.root, "modules/nested/nested.go");

		const resolved = resolveWorkspacePath({
			strategy: "language-project-root",
			path: dirname(nestedSourceFile),
			fallback: "given-directory",
			extension: ".go",
		});

		expect(resolved).toEqual({ found: true, root: join(fixture.root, "modules/nested") });
	});

	it("materializes bounded Git history with a symbol and path rename", async () => {
		const gitFixture = materializeGoReferenceGitFixture();
		fixture = gitFixture;
		const git = new LocalGit(gitFixture.root);

		const log = await git.log(2);
		const diff = await git.diff(gitFixture.baselineRef, 20_000);

		expect(log.map(({ message }) => message)).toEqual(["rename order contract", "baseline payment contract"]);
		expect(diff.truncated).toBe(false);
		expect(diff.diff).toContain("purchase.go");
		expect(diff.diff).toContain("PurchaseOrder");
	});
});
