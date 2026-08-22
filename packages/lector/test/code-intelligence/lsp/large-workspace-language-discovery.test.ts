import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CPP_DESCRIPTOR, PYTHON_DESCRIPTOR } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { discoverWorkspaceDescriptors } from "../../../src/code-intelligence/lsp/discover-seed-file.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function freshRoot(): string {
	root = mkdtempSync(join(tmpdir(), "lector-large-workspace-"));
	return root;
}

/**
 * A real, previously-confirmed correctness failure: the per-descriptor bounded scan was
 * depth-first, so an early alphabetical top-level subtree (here "assets", scanned fully to
 * MAX_SCAN_DEPTH before any sibling) could exhaust the whole entry budget before the scan ever
 * reached a later sibling ("src") containing the other language's own real source files. The
 * later language was then silently dropped from workspace discovery -- not because it was
 * absent, but because the scan never got there.
 */
function buildStarvingWorkspace(dir: string, highCardinalityEntryCount: number): void {
	// Alphabetically first, wide and deep enough to consume the whole shared entry budget under
	// depth-first-first-sibling ordering before a breadth-first-fair scan would move on.
	for (let i = 0; i < highCardinalityEntryCount; i++) {
		const bucket = join(dir, "assets", `bucket-${String(i).padStart(5, "0")}`);
		mkdirSync(bucket, { recursive: true });
		writeFileSync(join(bucket, "asset.bin"), "");
	}
	// Alphabetically later: Python (already commonly discovered) plus C sources that a
	// depth-first-starved scan would never reach.
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "main.py"), "value = 1\n");
	writeFileSync(join(dir, "src", "engine.c"), "int main(void) { return 0; }\n");
}

describe("discoverWorkspaceDescriptors under a large, unevenly-distributed workspace", () => {
	it("discovers a later language's seed file even when an earlier alphabetical subtree is large enough to exhaust a naive depth-first budget", () => {
		const dir = freshRoot();
		buildStarvingWorkspace(dir, 3_000);

		const discovered = discoverWorkspaceDescriptors(dir, [PYTHON_DESCRIPTOR, CPP_DESCRIPTOR]);
		const languageIds = discovered.map(({ descriptor }) => descriptor.languageId);

		expect(languageIds).toContain("python");
		expect(languageIds).toContain("cpp");
	});

	it("still finds both languages when the starving subtree is nested one level deeper than the target", () => {
		const dir = freshRoot();
		// A single top-level "aardvark" directory whose own subtree is wide, so a depth-first scan
		// descends fully into it before ever returning to sibling "src".
		for (let i = 0; i < 3_000; i++) {
			const bucket = join(dir, "aardvark", `f-${String(i).padStart(5, "0")}.bin`);
			mkdirSync(join(dir, "aardvark"), { recursive: true });
			writeFileSync(bucket, "");
		}
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "main.py"), "value = 1\n");
		writeFileSync(join(dir, "src", "engine.c"), "int main(void) { return 0; }\n");

		const discovered = discoverWorkspaceDescriptors(dir, [PYTHON_DESCRIPTOR, CPP_DESCRIPTOR]);
		const languageIds = discovered.map(({ descriptor }) => descriptor.languageId);

		expect(languageIds).toContain("python");
		expect(languageIds).toContain("cpp");
	});
});
