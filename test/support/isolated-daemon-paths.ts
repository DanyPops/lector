import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLectorPaths } from "../../src/constants.ts";

/**
 * A fresh XDG root per call, so daemon tests never share a token/handle file
 * with the real Lector install or with each other.
 */
export function isolatedLectorPaths() {
	const root = mkdtempSync(join(tmpdir(), "lector-test-"));
	const paths = resolveLectorPaths({
		env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
	});
	return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
