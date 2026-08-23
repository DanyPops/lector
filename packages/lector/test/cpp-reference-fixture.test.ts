import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalGit } from "../src/git/local-git.ts";
import {
	type CppReferenceFixture,
	materializeCppReferenceFixture,
	materializeCppReferenceGitFixture,
	readCppReferenceManifest,
} from "./support/cpp-reference-fixture.ts";

let fixture: CppReferenceFixture | undefined;

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("C/C++ reference fixture", () => {
	it("materializes an isolated project with every declared source and package-resolution case", () => {
		fixture = materializeCppReferenceFixture();
		const manifest = readCppReferenceManifest(fixture.root);

		for (const path of manifest.requiredPaths) expect(existsSync(join(fixture.root, path))).toBe(true);
		expect(existsSync(join(fixture.root, "compile_commands.json"))).toBe(true);
		expect(manifest.languages).toEqual(["c", "cpp"]);
		expect(manifest.packageManagers).toEqual(["conan", "vcpkg", "cmake-fetchcontent"]);
		expect(manifest.expectedSymbols.map(({ name }) => name)).toEqual(
			expect.arrayContaining(["PaymentProcessor", "StripeProcessor", "RunCheckout", "MaxValue"]),
		);
	});

	it("substitutes the real materialized root into compile_commands.json, once per fixture instance", () => {
		const first = materializeCppReferenceFixture();
		const second = materializeCppReferenceFixture();
		try {
			const firstCommands: unknown = JSON.parse(readFileSync(join(first.root, "compile_commands.json"), "utf8"));
			const secondCommands: unknown = JSON.parse(readFileSync(join(second.root, "compile_commands.json"), "utf8"));
			expect(JSON.stringify(firstCommands)).toContain(first.root);
			expect(JSON.stringify(firstCommands)).not.toContain("__FIXTURE_ROOT__");
			expect(JSON.stringify(secondCommands)).toContain(second.root);
			expect(first.root).not.toBe(second.root);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it("copies source so mutation tests cannot corrupt the committed fixture", () => {
		fixture = materializeCppReferenceFixture();
		const relativePath = "include/contracts/payment.h";
		const materializedPath = join(fixture.root, relativePath);
		const committedPath = join(fixture.sourceRoot, relativePath);
		const original = readFileSync(committedPath, "utf8");

		writeFileSync(materializedPath, "#pragma once\nconstexpr bool kChanged = true;\n");

		expect(readFileSync(committedPath, "utf8")).toBe(original);
	});

	it("materializes bounded Git history with a symbol and path rename", async () => {
		const gitFixture = materializeCppReferenceGitFixture();
		fixture = gitFixture;
		const git = new LocalGit(gitFixture.root);

		const log = await git.log(2);
		const diff = await git.diff(gitFixture.baselineRef, 20_000);

		expect(log.map(({ message }) => message)).toEqual(["rename order contract", "baseline payment contract"]);
		expect(diff.truncated).toBe(false);
		expect(diff.diff).toContain("purchase.h");
		expect(diff.diff).toContain("PurchaseOrder");
	});
});
