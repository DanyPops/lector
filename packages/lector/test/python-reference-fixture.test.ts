import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalGit } from "../src/git/local-git.ts";
import {
	materializePythonReferenceFixture,
	materializePythonReferenceGitFixture,
	type PythonReferenceFixture,
	readPythonReferenceManifest,
} from "./support/python-reference-fixture.ts";

let fixture: PythonReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("Python reference fixture", () => {
	it("materializes an isolated project with every declared source and package-resolution case", () => {
		fixture = materializePythonReferenceFixture();
		const manifest = readPythonReferenceManifest(fixture.root);

		for (const path of manifest.requiredPaths) expect(existsSync(join(fixture.root, path))).toBe(true);
		expect(manifest.languages).toEqual(["python"]);
		expect(manifest.packageManagers).toEqual(["pip", "poetry", "uv", "pipenv"]);
		expect(manifest.expectedSymbols.map(({ name }) => name)).toEqual(
			expect.arrayContaining(["PaymentProcessor", "StripeProcessor", "run_checkout", "LegacyGateway"]),
		);
	});

	it("copies source so mutation tests cannot corrupt the committed fixture", () => {
		fixture = materializePythonReferenceFixture();
		const relativePath = "contracts/payment.py";
		const materializedPath = join(fixture.root, relativePath);
		const committedPath = join(fixture.sourceRoot, relativePath);
		const original = readFileSync(committedPath, "utf8");

		writeFileSync(materializedPath, "changed = True\n");

		expect(readFileSync(committedPath, "utf8")).toBe(original);
	});

	it("materializes bounded Git history with a symbol and path rename", async () => {
		const gitFixture = materializePythonReferenceGitFixture();
		fixture = gitFixture;
		const git = new LocalGit(gitFixture.root);

		const log = await git.log(2);
		const diff = await git.diff(gitFixture.baselineRef, 20_000);

		expect(log.map(({ message }) => message)).toEqual(["rename order contract", "baseline payment contract"]);
		expect(diff.truncated).toBe(false);
		expect(diff.diff).toContain("purchase.py");
		expect(diff.diff).toContain("PurchaseOrder");
	});
});
