import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSourceManifest, SourceManifestLimitExceeded } from "../../src/workspace/source-manifest.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function fixture(): string {
	root = mkdtempSync(join(tmpdir(), "lector-source-manifest-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
	return root;
}

describe("deriveSourceManifest", () => {
	it("is deterministic for the same bounded source-file set", async () => {
		const directory = fixture();
		const first = await deriveSourceManifest(directory, [".ts"], 10, 10_000);
		const second = await deriveSourceManifest(directory, [".ts"], 10, 10_000);
		expect(second).toEqual(first);
	});

	it("changes when source content changes even if the path does not", async () => {
		const directory = fixture();
		const before = await deriveSourceManifest(directory, [".ts"], 10, 10_000);
		writeFileSync(join(directory, "src", "a.ts"), "export const a = 9;\n");
		const after = await deriveSourceManifest(directory, [".ts"], 10, 10_000);
		expect(after.fingerprint).not.toBe(before.fingerprint);
	});

	it("uses the same maxFiles bound as population", async () => {
		const directory = fixture();
		const manifest = await deriveSourceManifest(directory, [".ts"], 1, 10_000);
		expect(manifest.absoluteFiles).toHaveLength(1);
		const [selectedFile] = manifest.absoluteFiles;
		if (!selectedFile) throw new Error("expected one selected source file");
		expect([join(directory, "src", "a.ts"), join(directory, "src", "b.ts")]).toContain(selectedFile);
	});

	it("records each file's own content hash, changing only for the file that actually changed", async () => {
		const directory = fixture();
		const before = await deriveSourceManifest(directory, [".ts"], 10, 10_000);
		const aPath = join(directory, "src", "a.ts");
		const bPath = join(directory, "src", "b.ts");
		writeFileSync(aPath, "export const a = 9;\n");
		const after = await deriveSourceManifest(directory, [".ts"], 10, 10_000);

		expect(after.fileHashes.get(aPath)).not.toBe(before.fileHashes.get(aPath));
		expect(after.fileHashes.get(bPath)).toBe(before.fileHashes.get(bPath));
	});

	it("rejects a manifest whose source content exceeds maxBytes before returning a partial fingerprint", async () => {
		const directory = fixture();
		await expect(deriveSourceManifest(directory, [".ts"], 10, 5)).rejects.toBeInstanceOf(SourceManifestLimitExceeded);
	});
});
