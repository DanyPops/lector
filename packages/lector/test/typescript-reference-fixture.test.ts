import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalGit } from "../src/git/local-git.ts";
import {
	materializeTypeScriptReferenceFixture,
	materializeTypeScriptReferenceGitFixture,
	readTypeScriptReferenceManifest,
	type TypeScriptReferenceFixture,
} from "./support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("TypeScript/JavaScript reference fixture", () => {
	it("materializes an isolated monorepo with every declared source and package-resolution case", () => {
		fixture = materializeTypeScriptReferenceFixture();
		const manifest = readTypeScriptReferenceManifest(fixture.root);

		for (const path of manifest.requiredPaths) expect(existsSync(join(fixture.root, path))).toBe(true);
		expect(manifest.languages).toEqual(["typescript", "javascript", "tsx", "jsx"]);
		expect(manifest.packageManagers).toEqual(["npm", "pnpm", "yarn", "bun"]);
		expect(manifest.expectedSymbols.map(({ name }) => name)).toEqual(
			expect.arrayContaining(["PaymentProcessor", "StripeProcessor", "runCheckout", "LegacyGateway"]),
		);
	});

	it("copies source so mutation tests cannot corrupt the committed fixture", () => {
		fixture = materializeTypeScriptReferenceFixture();
		const relativePath = "packages/contracts/src/payment.ts";
		const materializedPath = join(fixture.root, relativePath);
		const committedPath = join(fixture.sourceRoot, relativePath);
		const original = readFileSync(committedPath, "utf8");

		writeFileSync(materializedPath, "export const changed = true;\n");

		expect(readFileSync(committedPath, "utf8")).toBe(original);
	});

	it("materializes bounded Git history with an API and path rename", async () => {
		const gitFixture = materializeTypeScriptReferenceGitFixture();
		fixture = gitFixture;
		const git = new LocalGit(gitFixture.root);

		const log = await git.log(2);
		const diff = await git.diff(gitFixture.baselineRef, 20_000);

		expect(log.map(({ message }) => message)).toEqual(["rename order contract", "baseline payment contract"]);
		expect(diff.truncated).toBe(false);
		expect(diff.diff).toContain("purchase.ts");
		expect(diff.diff).toContain("PurchaseOrder");
	});
});
