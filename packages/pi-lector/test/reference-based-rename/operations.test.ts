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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createReferenceBasedRenameOperations } from "../../extension/src/reference-based-rename/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

function buildProjectFixture(): { root: string; mathFile: string; consumerFile: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-reference-based-rename-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "src"));
	const mathFile = join(root, "src", "math.ts");
	writeFileSync(mathFile, "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	const consumerFile = join(root, "src", "consumer.ts");
	writeFileSync(consumerFile, 'import { add } from "./math";\n\nadd(1, 2);\n');
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return { root, mathFile, consumerFile };
}

describe("Lector-backed reference-based rename operations", () => {
	it("moves a real file and rewrites a real importing file's specifier via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile, consumerFile } = buildProjectFixture();
		projectDir = root;
		const toPath = join(root, "src", "arithmetic.ts");

		await daemon.client
			.call("workspace.registerPath", { path: root })
			.then(({ workspaceId }) => daemon.client.call("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 }));

		const ops = createReferenceBasedRenameOperations();
		const outcome = await ops.rename(mathFile, toPath, 10, 10);

		expect(outcome.movedTo).toBe(toPath);
		expect(outcome.filesUpdated).toEqual([consumerFile]);
		expect(readFileSync(consumerFile, "utf8")).toContain('from "./arithmetic"');
	}, 20_000);
});
