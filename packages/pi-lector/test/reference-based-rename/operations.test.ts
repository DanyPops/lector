/**
 * createReferenceBasedRenameOperations wraps Lector's non-LSP reference-based rename,
 * resolving its own workspace per fromPath (workspaceForCodeIntelligencePath -- this spawns a
 * real language server, matching every other code-intelligence operation's convention).
 *
 * Full semantic correctness of the underlying operation is already covered directly against a
 * live typescript-language-server in Lector's own
 * test/service-reference-based-rename.test.ts; this file only proves the pi-lector wrapper
 * wires workspace resolution and the daemon call correctly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createReferenceBasedRenameOperations } from "../../extension/src/reference-based-rename/operations.ts";
import { createWorkspaceCacheOperations } from "../../extension/src/workspace-cache/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";
import { buildNestedTypeScriptMonorepoFixture } from "../support/nested-typescript-monorepo.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed reference-based rename operations", () => {
	it("moves a real file and rewrites a real importing file's specifier via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const fixture = buildNestedTypeScriptMonorepoFixture("pi-lector-reference-based-rename-");
		projectDir = fixture.root;
		const toPath = join(fixture.sourceDirectory, "arithmetic.ts");

		const cache = createWorkspaceCacheOperations();
		const submitted = await cache.submit(fixture.packageRoot, 10, 10);
		let completed = submitted;
		for (let attempt = 0; attempt < 200 && completed.status !== "succeeded" && completed.status !== "failed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			completed = await cache.jobStatus(submitted.id);
		}
		expect(completed.status).toBe("succeeded");
		expect((await cache.status(fixture.sourceDirectory, 10, 10)).status).toBe("cached");

		const ops = createReferenceBasedRenameOperations();
		const outcome = await ops.rename(fixture.declarationFile, toPath, 10, 10);

		expect(outcome.movedTo).toBe(toPath);
		expect(outcome.filesUpdated).toEqual([fixture.consumerFile]);
		expect(readFileSync(fixture.consumerFile, "utf8")).toContain('from "./arithmetic"');
	}, 20_000);
});
