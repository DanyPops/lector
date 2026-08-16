/**
 * createLectorSymbolAnnotationOperations wraps Lector's annotation
 * operations. Service-level correctness (anchor resolution, live staleness
 * detection) is already covered directly in Lector's own
 * test/service-symbol-annotations.test.ts; this file only proves the
 * pi-lector wrapper wires workspace resolution and the daemon call
 * correctly, against a real spawned daemon and a real LSP-populated graph.
 *
 * Every operation dispatches through the daemon's real Vehicle protocol
 * (/vehicle/manifest, /vehicle/invoke -- see vehicle-client.ts), so each test
 * wires both the legacy LectorClient connector (workspace resolution, and
 * code-intelligence's own populateSymbolGraph/documentSymbols) and the
 * vehicle client connector against the same isolated daemon.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLectorCodeIntelligenceOperations } from "../../extension/src/code-intelligence/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { type LectorVehicleCall, resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
import { createLectorSymbolAnnotationOperations } from "../../extension/src/symbol-annotation/operations.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
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

async function wireDaemon(): Promise<{ baseUrl: string; token: string; stop: () => Promise<void> }> {
	const daemon = await startIsolatedLectorDaemon();
	stopDaemon = daemon.stop;
	setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
	setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));
	return daemon;
}

let nextToolCallId = 0;

async function vehicleCall(cwd: string): Promise<LectorVehicleCall> {
	const h = createExtensionHarness(async () => {}, { cwd });
	await h.boot();
	const ctx: ExtensionContext = h.ctx;
	return { toolName: "symbol_annotations", toolCallId: `t${++nextToolCallId}`, context: ctx };
}

describe("Lector-backed annotation operations", () => {
	it("creates, gets, lists, refreshes, scrubs, and restores an annotation via a running Lector daemon", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const call = await vehicleCall(root);
		const ops = createLectorSymbolAnnotationOperations();

		const { annotation: created } = await ops.create(mathFile, "user-story-dataflow", "add flow", "explains addition", [anchor], call);
		expect(created.status).toBe("fresh");

		const { annotation: fetched } = await ops.get(mathFile, created.id, call);
		expect(fetched?.status).toBe("fresh");

		const { annotations } = await ops.list(mathFile, {}, call);
		expect(annotations.map((a) => a.id)).toContain(created.id);

		const { annotation: refreshed } = await ops.refresh(mathFile, created.id, "user-story-dataflow", "add flow", "updated narrative", [anchor], call);
		expect(refreshed?.body).toBe("updated narrative");

		const { scrubbed } = await ops.scrub(mathFile, created.id, call);
		expect(scrubbed).toBe(true);
		const { annotations: afterScrub } = await ops.list(mathFile, {}, call);
		expect(afterScrub.map((a) => a.id)).not.toContain(created.id);

		const { restored } = await ops.restore(mathFile, created.id, call);
		expect(restored).toBe(true);
	}, 20_000);

	it("rejects an anchor that does not resolve to a real symbol", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const codeIntelligence = createLectorCodeIntelligenceOperations();
		await codeIntelligence.populateSymbolGraph(mathFile, 10, 10, 5_000);

		const call = await vehicleCall(root);
		const ops = createLectorSymbolAnnotationOperations();
		await expect(ops.create(mathFile, "comment", "t", "b", [{ path: mathFile, line: 999, character: 1 }], call)).rejects.toThrow();
	}, 20_000);

	it("list(query) filters by title/body via a running Lector daemon", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const call = await vehicleCall(root);
		const ops = createLectorSymbolAnnotationOperations();
		await ops.create(mathFile, "comment", "addition dataflow", "explains how add() combines its inputs", [anchor], call);
		await ops.create(mathFile, "comment", "unrelated note", "nothing to do with it", [anchor], call);

		const { annotations } = await ops.list(mathFile, { query: "dataflow" }, call);

		expect(annotations.map((a) => a.title)).toEqual(["addition dataflow"]);
	}, 20_000);

	it("contains, reads via tree, and uncontains via a running Lector daemon", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const call = await vehicleCall(root);
		const ops = createLectorSymbolAnnotationOperations();
		const { annotation: flow } = await ops.create(mathFile, "comment", "flow", "b", [anchor], call);
		const { annotation: step } = await ops.create(mathFile, "comment", "step", "b", [anchor], call);

		const { contained } = await ops.contain(mathFile, flow.id, step.id, call);
		expect(contained).toBe(true);

		const { annotations } = await ops.tree(mathFile, flow.id, 5, call);
		expect(annotations.map((a) => a.id).sort()).toEqual([flow.id, step.id].sort());

		const { uncontained } = await ops.uncontain(mathFile, flow.id, step.id, call);
		expect(uncontained).toBe(true);
		const { annotations: afterUncontain } = await ops.tree(mathFile, flow.id, 5, call);
		expect(afterUncontain.map((a) => a.id)).toEqual([flow.id]);
	}, 20_000);

	it("resolves scope from a project directory the same way it resolves from a file inside it -- the real bug this fixes (dirname() silently resolving a project's own root to its parent)", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const call = await vehicleCall(root);
		const ops = createLectorSymbolAnnotationOperations();
		const { annotation: created } = await ops.create(root, "comment", "dir-scoped", "created via the project directory itself", [anchor], call);

		// The exact same annotation is visible whether the scope was resolved from the directory or a file inside it.
		const { annotation: fetchedViaFile } = await ops.get(mathFile, created.id, call);
		expect(fetchedViaFile?.id).toBe(created.id);

		const { annotations: listedViaDir } = await ops.list(root, {}, call);
		expect(listedViaDir.map((a) => a.id)).toContain(created.id);

		const { annotation: refreshed } = await ops.refresh(root, created.id, "comment", "dir-scoped", "refreshed via the project directory", [anchor], call);
		expect(refreshed?.body).toBe("refreshed via the project directory");

		const { annotation: child } = await ops.create(mathFile, "comment", "child", "b", [anchor], call);
		await ops.contain(root, created.id, child.id, call);
		const { annotations: tree } = await ops.tree(root, created.id, 5, call);
		expect(tree.map((a) => a.id).sort()).toEqual([created.id, child.id].sort());
	}, 20_000);

	it("rejects an anchor outside the resolved workspace, before it is ever persisted", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;
		const outsideRoot = mkdtempSync(join(tmpdir(), "pi-lector-annotations-outside-"));
		try {
			const outsideFile = join(outsideRoot, "unrelated.ts");
			writeFileSync(outsideFile, "export const unrelated = 1;\n");

			const call = await vehicleCall(root);
			const ops = createLectorSymbolAnnotationOperations();
			// mathFile's own workspace is `root`; this anchor names a real file, but one entirely
			// outside that workspace's tree -- PathEscapesWorkspaceRoot must refuse it.
			await expect(ops.create(mathFile, "comment", "t", "b", [{ path: outsideFile, line: 1, character: 1 }], call)).rejects.toThrow();
		} finally {
			rmSync(outsideRoot, { recursive: true, force: true });
		}
	}, 20_000);

	it("rejects a containment cycle via a running Lector daemon", async () => {
		await wireDaemon();
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const anchor = await realAnchor(mathFile);
		const call = await vehicleCall(root);
		const ops = createLectorSymbolAnnotationOperations();
		const { annotation: a } = await ops.create(mathFile, "comment", "a", "b", [anchor], call);
		const { annotation: b } = await ops.create(mathFile, "comment", "b", "b", [anchor], call);
		await ops.contain(mathFile, a.id, b.id, call);

		await expect(ops.contain(mathFile, b.id, a.id, call)).rejects.toThrow();
	}, 20_000);
});
