import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface GoMediumPrometheusClientFixture {
	readonly root: string;
	readonly sourceRoot: string;
	dispose(): void;
}

const SOURCE_ROOT = fileURLToPath(new URL("../fixtures/go-medium-prometheus-client", import.meta.url));

export function materializeGoMediumPrometheusClientFixture(): GoMediumPrometheusClientFixture {
	const root = mkdtempSync(join(tmpdir(), "lector-go-medium-prometheus-client-"));
	cpSync(SOURCE_ROOT, root, { recursive: true });
	return {
		root,
		sourceRoot: SOURCE_ROOT,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
