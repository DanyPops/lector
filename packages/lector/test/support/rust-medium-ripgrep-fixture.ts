import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RustMediumRipgrepFixture {
	readonly root: string;
	readonly sourceRoot: string;
	dispose(): void;
}

const SOURCE_ROOT = fileURLToPath(new URL("../fixtures/rust-medium-ripgrep", import.meta.url));

export function materializeRustMediumRipgrepFixture(): RustMediumRipgrepFixture {
	const root = mkdtempSync(join(tmpdir(), "lector-rust-medium-ripgrep-"));
	cpSync(SOURCE_ROOT, root, { recursive: true });
	return {
		root,
		sourceRoot: SOURCE_ROOT,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
