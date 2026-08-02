/**
 * createLectorSymbolAnnotationOperations wraps Lector's annotation
 * operations. Service-level correctness (anchor resolution, live staleness
 * detection) is already covered directly in Lector's own
 * test/service-symbol-annotations.test.ts; this file only proves the
 * pi-lector wrapper wires workspace resolution and the daemon call
 * correctly, against a real spawned daemon and a real LSP-populated graph.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorCodeIntelligenceOperations } from "../../extension/src/code-intelligence/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { createLectorSymbolAnnotationOperations } from "../../extension/src/symbol-annotation/operations.ts";
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

function buildProjectFixture(): { root: string; mathFile: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-annotations-"));
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, "src"));
	const mathFile = join(root, "src", "math.ts");
	writeFileSync(mathFile, "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return { root, mathFile };
}

/** populateSymbolGraph derives a node's SymbolNodeId from documentSymbols' own selectionRange.start -- matches the CLI parity test's own discovery. */
async function realAnchor(mathFile: string): Promise<{ path: string; line: number; character: number }> {
	const codeIntelligence = createLectorCodeIntelligenceOperations();
	await codeIntelligence.populateSymbolGraph(mathFile, 10, 10, 5_000);
	const { symbols } = await codeIntelligence.documentSymbols(mathFile);
	const add = symbols.find((s) => s.name === "add");
	if (!add) throw new Error("fixture symbol 'add' was not found by workspace.documentSymbols");
	return { path: mathFile, line: add.selectionRange.start.line, character: add.selectionRange.start.character };
}

describe("Lector-backed annotation operations", () => {
	it("creates, gets, lists, refreshes, scrubs, and restores an annotation via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const ops = createLectorSymbolAnnotationOperations();

		const { annotation: created } = await ops.create(mathFile, "user-story-dataflow", "add flow", "explains addition", [anchor]);
		expect(created.status).toBe("fresh");

		const { annotation: fetched } = await ops.get(mathFile, created.id);
		expect(fetched?.status).toBe("fresh");

		const { annotations } = await ops.list(mathFile);
		expect(annotations.map((a) => a.id)).toContain(created.id);

		const { annotation: refreshed } = await ops.refresh(mathFile, created.id, "user-story-dataflow", "add flow", "updated narrative", [anchor]);
		expect(refreshed?.body).toBe("updated narrative");

		const { scrubbed } = await ops.scrub(mathFile, created.id);
		expect(scrubbed).toBe(true);
		const { annotations: afterScrub } = await ops.list(mathFile);
		expect(afterScrub.map((a) => a.id)).not.toContain(created.id);

		const { restored } = await ops.restore(mathFile, created.id);
		expect(restored).toBe(true);
	}, 20_000);

	it("rejects an anchor that does not resolve to a real symbol", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const codeIntelligence = createLectorCodeIntelligenceOperations();
		await codeIntelligence.populateSymbolGraph(mathFile, 10, 10, 5_000);

		const ops = createLectorSymbolAnnotationOperations();
		await expect(ops.create(mathFile, "comment", "t", "b", [{ path: mathFile, line: 999, character: 1 }])).rejects.toThrow();
	}, 20_000);

	it("list(query) filters by title/body via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const ops = createLectorSymbolAnnotationOperations();
		await ops.create(mathFile, "comment", "addition dataflow", "explains how add() combines its inputs", [anchor]);
		await ops.create(mathFile, "comment", "unrelated note", "nothing to do with it", [anchor]);

		const { annotations } = await ops.list(mathFile, { query: "dataflow" });

		expect(annotations.map((a) => a.title)).toEqual(["addition dataflow"]);
	}, 20_000);

	it("contains, reads via tree, and uncontains via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const ops = createLectorSymbolAnnotationOperations();
		const { annotation: flow } = await ops.create(mathFile, "comment", "flow", "b", [anchor]);
		const { annotation: step } = await ops.create(mathFile, "comment", "step", "b", [anchor]);

		const { contained } = await ops.contain(mathFile, flow.id, step.id);
		expect(contained).toBe(true);

		const { annotations } = await ops.tree(mathFile, flow.id, 5);
		expect(annotations.map((a) => a.id).sort()).toEqual([flow.id, step.id].sort());

		const { uncontained } = await ops.uncontain(mathFile, flow.id, step.id);
		expect(uncontained).toBe(true);
		const { annotations: afterUncontain } = await ops.tree(mathFile, flow.id, 5);
		expect(afterUncontain.map((a) => a.id)).toEqual([flow.id]);
	}, 20_000);

	it("rejects a containment cycle via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const ops = createLectorSymbolAnnotationOperations();
		const { annotation: a } = await ops.create(mathFile, "comment", "a", "b", [anchor]);
		const { annotation: b } = await ops.create(mathFile, "comment", "b", "b", [anchor]);
		await ops.contain(mathFile, a.id, b.id);

		await expect(ops.contain(mathFile, b.id, a.id)).rejects.toThrow();
	}, 20_000);
});
