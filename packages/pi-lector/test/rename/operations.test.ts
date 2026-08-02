/**
 * createRenameOperations wraps Lector's LSP-driven prepareRename/rename, resolving its own
 * workspace per path (workspaceForCodeIntelligencePath -- spawns a real language server).
 *
 * Full semantic correctness of the underlying operation is already covered directly against a
 * live typescript-language-server in Lector's own test/service-rename.test.ts; this file only
 * proves the pi-lector wrapper wires workspace resolution and the daemon call correctly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createRenameOperations } from "../../extension/src/rename/operations.ts";
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
	const root = mkdtempSync(join(tmpdir(), "pi-lector-rename-"));
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

describe("Lector-backed rename operations", () => {
	it("prepareRename reports a real renameable range via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createRenameOperations();
		const result = await ops.prepareRename(mathFile, 1, 17);

		expect(result.range).not.toBeNull();
	}, 20_000);

	it("rename rewrites the declaration and its cross-file usage via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile, consumerFile } = buildProjectFixture();
		projectDir = root;
		await daemon.client
			.call("workspace.registerPath", { path: root })
			.then(({ workspaceId }) => daemon.client.call("workspace.documentSymbols", { workspaceId, path: consumerFile }));

		const ops = createRenameOperations();
		const result = await ops.rename(mathFile, 1, 17, "sum");

		expect([...result.touchedPaths].sort()).toEqual([consumerFile, mathFile].sort());
		expect(readFileSync(mathFile, "utf8")).toContain("export function sum");
		expect(readFileSync(consumerFile, "utf8")).toContain("sum(1, 2)");
	}, 20_000);
});
