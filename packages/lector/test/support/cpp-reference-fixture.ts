import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CppReferenceManifest {
	readonly version: number;
	readonly languages: readonly string[];
	readonly packageManagers: readonly string[];
	readonly requiredPaths: readonly string[];
	readonly expectedSymbols: readonly { readonly name: string; readonly kind: string; readonly path: string }[];
	readonly diagnostic: { readonly path: string; readonly messageIncludes: string };
	readonly lexicalMarker: string;
}

export interface CppReferenceFixture {
	readonly root: string;
	readonly sourceRoot: string;
	dispose(): void;
}

export interface CppReferenceGitFixture extends CppReferenceFixture {
	readonly baselineRef: string;
	readonly changedRef: string;
}

const SOURCE_ROOT = fileURLToPath(new URL("../fixtures/cpp-reference", import.meta.url));
const FIXTURE_ROOT_PLACEHOLDER = "__FIXTURE_ROOT__";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isExpectedSymbols(value: unknown): value is { name: string; kind: string; path: string }[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.kind === "string" && typeof entry.path === "string")
	);
}

export function readCppReferenceManifest(root = SOURCE_ROOT): CppReferenceManifest {
	const value: unknown = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
	if (
		!isRecord(value) ||
		typeof value.version !== "number" ||
		!isStringArray(value.languages) ||
		!isStringArray(value.packageManagers) ||
		!isStringArray(value.requiredPaths) ||
		!isExpectedSymbols(value.expectedSymbols) ||
		!isRecord(value.diagnostic) ||
		typeof value.diagnostic.path !== "string" ||
		typeof value.diagnostic.messageIncludes !== "string" ||
		typeof value.lexicalMarker !== "string"
	) {
		throw new Error("Invalid C/C++ reference fixture manifest");
	}
	return {
		version: value.version,
		languages: value.languages,
		packageManagers: value.packageManagers,
		requiredPaths: value.requiredPaths,
		expectedSymbols: value.expectedSymbols,
		diagnostic: { path: value.diagnostic.path, messageIncludes: value.diagnostic.messageIncludes },
		lexicalMarker: value.lexicalMarker,
	};
}

/**
 * clangd's JSON compilation database needs each entry's own absolute "directory"/"file" paths --
 * unlike every other reference fixture's static committed manifest, this one can't be committed
 * verbatim since the materialized root is a fresh tmpdir every run. The committed
 * compile_commands.json.template carries a __FIXTURE_ROOT__ placeholder instead, substituted for
 * the real materialized root here, mirroring the git-fixture's own post-copy rewrite step.
 */
function materializeCompileCommands(root: string): void {
	const templatePath = join(root, "compile_commands.json.template");
	const template = readFileSync(templatePath, "utf8");
	writeFileSync(join(root, "compile_commands.json"), template.split(FIXTURE_ROOT_PLACEHOLDER).join(root));
	rmSync(templatePath);
}

export function materializeCppReferenceFixture(): CppReferenceFixture {
	const root = mkdtempSync(join(tmpdir(), "lector-cpp-reference-"));
	cpSync(SOURCE_ROOT, root, { recursive: true });
	copyFileSync(join(root, "gitignore.fixture"), join(root, ".gitignore"));
	rmSync(join(root, "gitignore.fixture"));
	materializeCompileCommands(root);
	return {
		root,
		sourceRoot: SOURCE_ROOT,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function git(root: string, ...args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

export function materializeCppReferenceGitFixture(): CppReferenceGitFixture {
	const fixture = materializeCppReferenceFixture();
	const paymentPath = join(fixture.root, "include/contracts/payment.h");
	const purchasePath = join(fixture.root, "include/contracts/purchase.h");
	copyFileSync(join(fixture.root, "history/v1/payment.h"), paymentPath);
	git(fixture.root, "init", "-q");
	git(fixture.root, "config", "user.email", "fixture@lector.invalid");
	git(fixture.root, "config", "user.name", "Lector Fixture");
	git(fixture.root, "add", "-A");
	git(fixture.root, "commit", "-q", "-m", "baseline payment contract");
	git(fixture.root, "tag", "fixture-v1");

	renameSync(paymentPath, purchasePath);
	copyFileSync(join(fixture.root, "history/v2/payment.h"), purchasePath);
	git(fixture.root, "add", "-A");
	git(fixture.root, "commit", "-q", "-m", "rename order contract");
	git(fixture.root, "tag", "fixture-v2");

	return { ...fixture, baselineRef: "fixture-v1", changedRef: "fixture-v2" };
}
