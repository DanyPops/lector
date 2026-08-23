import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RustReferenceManifest {
	readonly version: number;
	readonly languages: readonly string[];
	readonly packageManagers: readonly string[];
	readonly requiredPaths: readonly string[];
	readonly expectedSymbols: readonly { readonly name: string; readonly kind: string; readonly path: string }[];
	readonly diagnostic: { readonly path: string; readonly messageIncludes: string };
	readonly lexicalMarker: string;
}

export interface RustReferenceFixture {
	readonly root: string;
	readonly sourceRoot: string;
	dispose(): void;
}

export interface RustReferenceGitFixture extends RustReferenceFixture {
	readonly baselineRef: string;
	readonly changedRef: string;
}

const SOURCE_ROOT = fileURLToPath(new URL("../fixtures/rust-reference", import.meta.url));

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

export function readRustReferenceManifest(root = SOURCE_ROOT): RustReferenceManifest {
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
		throw new Error("Invalid Rust reference fixture manifest");
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

export function materializeRustReferenceFixture(): RustReferenceFixture {
	const root = mkdtempSync(join(tmpdir(), "lector-rust-reference-"));
	cpSync(SOURCE_ROOT, root, { recursive: true });
	copyFileSync(join(root, "gitignore.fixture"), join(root, ".gitignore"));
	rmSync(join(root, "gitignore.fixture"));
	return {
		root,
		sourceRoot: SOURCE_ROOT,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function git(root: string, ...args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

export function materializeRustReferenceGitFixture(): RustReferenceGitFixture {
	const fixture = materializeRustReferenceFixture();
	const paymentPath = join(fixture.root, "contracts/src/payment.rs");
	const purchasePath = join(fixture.root, "contracts/src/purchase.rs");
	const libPath = join(fixture.root, "contracts/src/lib.rs");
	copyFileSync(join(fixture.root, "history/v1/payment.rs"), paymentPath);
	git(fixture.root, "init", "-q");
	git(fixture.root, "config", "user.email", "fixture@lector.invalid");
	git(fixture.root, "config", "user.name", "Lector Fixture");
	git(fixture.root, "add", "-A");
	git(fixture.root, "commit", "-q", "-m", "baseline payment contract");
	git(fixture.root, "tag", "fixture-v1");

	renameSync(paymentPath, purchasePath);
	copyFileSync(join(fixture.root, "history/v2/payment.rs"), purchasePath);
	writeFileSync(libPath, "mod purchase;\npub use purchase::{PaymentProcessor, PurchaseOrder, Receipt};\n");
	git(fixture.root, "add", "-A");
	git(fixture.root, "commit", "-q", "-m", "rename order contract");
	git(fixture.root, "tag", "fixture-v2");

	return { ...fixture, baselineRef: "fixture-v1", changedRef: "fixture-v2" };
}
