import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TypescriptLargePrettierFixture {
	readonly root: string;
	readonly sourceRoot: string;
	dispose(): void;
}

const SOURCE_ROOT = fileURLToPath(new URL("../fixtures/typescript-large-prettier", import.meta.url));

export function materializeTypescriptLargePrettierFixture(): TypescriptLargePrettierFixture {
	const root = mkdtempSync(join(tmpdir(), "lector-typescript-large-prettier-"));
	cpSync(SOURCE_ROOT, root, { recursive: true });
	return {
		root,
		sourceRoot: SOURCE_ROOT,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
