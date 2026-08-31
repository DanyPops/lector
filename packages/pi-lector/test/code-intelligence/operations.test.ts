/**
 * createLectorCodeIntelligenceOperations wraps Lector's code-intelligence
 * operations (goToDefinition, findReferences, hover, documentSymbols,
 * diagnostics). Position-based, resolving its own workspace per absolute path touched
 * (workspaceForPath) -- the same per-call resolution read/write/edit/
 * find_symbols already use.
 *
 * Full semantic correctness of each underlying LSP operation is already
 * covered directly against a live typescript-language-server in Lector's
 * own test/adapters/lsp/typescript-symbol-index.test.ts; this file only
 * proves the pi-lector wrapper wires workspace resolution and the daemon
 * call correctly.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLectorCodeIntelligenceOperations } from "../../extension/src/code-intelligence/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { type LectorVehicleCall, resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
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

/** A real-enough git repo fixture: workspaceForPath's project-root boundary is a real .git marker, not the filesystem root fallback. */
function buildProjectFixture(): { root: string; mathFile: string; brokenFile: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-code-intelligence-"));
	mkdirSync(join(root, "src"));
	const mathFile = join(root, "src", "math.ts");
	writeFileSync(
		mathFile,
		"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n\nexport function addTwice(a: number, b: number): number {\n\treturn add(a, b) + add(a, b);\n}\n",
	);
	const brokenFile = join(root, "src", "broken.ts");
	writeFileSync(brokenFile, 'export const total: number = "not a number";\n');
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "fixture@lector.invalid"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Lector Fixture"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	return { root, mathFile, brokenFile };
}

async function vehicleCall(cwd: string): Promise<LectorVehicleCall> {
	const harness = createExtensionHarness(async () => {}, { cwd });
	await harness.boot();
	const context: ExtensionContext = harness.ctx;
	return { toolName: "code_action_preview", toolCallId: "code-action-test", context };
}

describe("Lector-backed code-intelligence operations", () => {
	it("documentSymbols lists a real file's declarations via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const symbols = await ops.documentSymbols(mathFile);

		const match = symbols.symbols.find((symbol) => symbol.name === "add");
		expect(symbols.provenance).toMatchObject({ fidelity: "semantic", backend: "typescript-language-server" });
		expect(match).toBeDefined();
		expect(match?.kind).toBe("function");
	}, 20_000);

	it("hover returns real type information for a known declaration", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		// Position on "add" in "export function add(...)" (0-indexed 16, 1-indexed 17).
		const hover = await ops.hover(mathFile, 1, 17);

		expect(hover.hover).toBeDefined();
		expect(hover.hover?.contents).toContain("add");
		expect(hover.provenance.fidelity).toBe("semantic");
	}, 20_000);

	it("goToDefinition and findReferences resolve real positions, not placeholders", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const definitions = await ops.goToDefinition(mathFile, 1, 17);
		const references = await ops.findReferences(mathFile, 1, 17, true);

		expect(definitions.locations.length).toBeGreaterThan(0);
		expect(definitions.locations[0]?.path).toBe(mathFile);
		expect(references.locations.length).toBeGreaterThan(0);
		expect(references.locations.some((location) => location.path === mathFile)).toBe(true);
		expect(references.provenance).toHaveProperty("languageId");

		const conciseReferences = await ops.findReferences(mathFile, 1, 17, true, "concise");
		expect(conciseReferences.locations).toEqual(references.locations);
		expect(conciseReferences.provenance).not.toHaveProperty("languageId");
	}, 20_000);

	it("goToImplementation crosses an interface/implementation boundary that goToDefinition cannot", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root } = buildProjectFixture();
		projectDir = root;
		const greeterFile = join(root, "src", "greeter.ts");
		writeFileSync(
			greeterFile,
			'interface Greeter {\n\tgreet(): string;\n}\n\nclass EnglishGreeter implements Greeter {\n\tgreet(): string {\n\t\treturn "hello";\n\t}\n}\n',
		);

		const ops = createLectorCodeIntelligenceOperations();
		// Position on "greet" in "greet(): string;" (the interface member).
		const implementations = await ops.goToImplementation(greeterFile, 2, 2);

		expect(implementations.locations.length).toBeGreaterThan(0);
		expect(implementations.locations.every((location) => location.path === greeterFile)).toBe(true);
	}, 20_000);

	it("diagnostics reports a real type error via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, brokenFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const diagnostics = await ops.diagnostics(brokenFile);

		expect(diagnostics.diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics.diagnostics[0]?.severity).toBe("error");
		expect(diagnostics.diagnostics[0]?.range.path).toBe(brokenFile);
	}, 20_000);

	it("previews and applies a guarded code action", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));
		const { root } = buildProjectFixture();
		projectDir = root;
		const call = await vehicleCall(root);
		const path = join(root, "src", "code-action.ts");
		writeFileSync(path, "export function load(): void {\n\tawait Promise.resolve();\n}\n");
		const ops = createLectorCodeIntelligenceOperations();
		const preview = await ops.previewCodeActions(
			path,
			{
				range: { start: { line: 2, character: 2 }, end: { line: 2, character: 7 } },
				only: ["quickfix"],
				maxActions: 10,
				maxEdits: 100,
				maxFiles: 10,
				maxBytes: 100_000,
				deadlineMs: 10_000,
			},
			call,
		);
		const action = preview.actions.find(({ title }) => /async/i.test(title));
		expect(action).toBeDefined();
		if (!action) throw new Error("expected async quick fix");
		const applied = await ops.applyCodeAction(path, action.id, { ...call, toolName: "code_action_apply" });
		expect(applied.transactionId).toBeDefined();
		expect(readFileSync(path, "utf8")).toContain("export async function load");
	}, 20_000);

	it("prepareCallHierarchy, incomingCalls, and outgoingCalls resolve a real call relationship via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		// Position on "add" in "export function add(...)" (0-indexed 16, 1-indexed 17).
		const roots = await ops.prepareCallHierarchy(mathFile, 1, 17);
		expect(roots.items.length).toBeGreaterThan(0);
		expect(roots.items[0]?.name).toBe("add");

		const callers = await ops.incomingCalls(mathFile, 1, 17);
		expect(callers.calls.some((call) => call.from.name === "addTwice")).toBe(true);

		// Position on "addTwice" in "export function addTwice(...)" (line 5: line 4 is the blank separator line).
		const callees = await ops.outgoingCalls(mathFile, 5, 17);
		expect(callees.calls.some((call) => call.to.name === "add")).toBe(true);
	}, 20_000);

	it("type hierarchy preserves capability-unavailable through the Pi wrapper", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		await expect(ops.prepareTypeHierarchy(mathFile, 1, 17, { maxResults: 10, maxBytes: 10_000, deadlineMs: 10_000 })).rejects.toThrow(
			"does not support type hierarchy",
		);
	}, 20_000);

	it("impactAnalysis returns changed symbols through the Pi wrapper", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;
		const ops = createLectorCodeIntelligenceOperations();
		await ops.populateSymbolGraph(root, 100, 100, 5_000);
		writeFileSync(mathFile, (await Bun.file(mathFile).text()).replace("return a + b;", "return a + b + 1;"));

		const result = await ops.impactAnalysis(
			root,
			{ kind: "git", ref: "HEAD" },
			{
				maxDepth: 2,
				autoPopulate: true,
				maxFiles: 100,
				maxSymbolsPerFile: 100,
				maxNodes: 100,
				maxEdges: 1_000,
				maxBytes: 100_000,
				deadlineMs: 20_000,
			},
		);
		expect(result.changedSymbols.length).toBeGreaterThan(0);
		expect(result.source).toEqual({ kind: "git", ref: "HEAD" });
		const delta = await ops.diagnosticDelta(
			root,
			{ kind: "git", ref: "HEAD" },
			{
				maxResults: 100,
				maxDepth: 2,
				autoPopulate: true,
				maxFiles: 100,
				maxSymbolsPerFile: 100,
				maxNodes: 100,
				maxEdges: 1_000,
				maxBytes: 100_000,
				deadlineMs: 30_000,
			},
		);
		expect(delta.source).toEqual({ kind: "git", ref: "HEAD" });
	}, 30_000);

	it("populateSymbolGraph and reachableFrom answer a real multi-hop question via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const populateJob = await ops.populateSymbolGraph(mathFile, 100, 50, 20_000);
		expect(populateJob.status).toBe("succeeded");
		if (populateJob.status !== "succeeded") throw new Error(`expected succeeded job, got ${populateJob.status}`);
		expect(populateJob.result.filesProcessed).toBeGreaterThan(0);
		expect(populateJob.result.edgesAdded).toBeGreaterThan(0);

		// addTwice (line 5) calls add (line 1) -- one hop.
		const reachable = await ops.reachableFrom(mathFile, 5, 17, 1, "calls");
		expect(reachable.some((symbol) => symbol.name === "add")).toBe(true);
	}, 20_000);

	it("reachableFrom auto-populates with explicit bounds through the Pi wrapper", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const reachable = await ops.reachableFrom(mathFile, 5, 17, 1, "calls", {
			autoPopulate: true,
			maxFiles: 100,
			maxSymbolsPerFile: 50,
		});

		expect(reachable.some((symbol) => symbol.name === "add")).toBe(true);
	}, 20_000);

	it("populateSymbolGraph and workspaceMap rank a real graph, most-called symbol first", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		await ops.populateSymbolGraph(mathFile, 100, 50, 20_000);

		// add is called twice by addTwice -- it should rank above addTwice itself, which nothing calls.
		const map = await ops.workspaceMap(mathFile, 1_000, 1_000, 100, 1_000_000);
		const names = map.entries.map((entry) => entry.name);
		expect(names.indexOf("add")).toBeLessThan(names.indexOf("addTwice"));
		expect(map.entries.find((entry) => entry.name === "add")?.signature).toContain("add");
	}, 20_000);

	it("populateSymbolGraph and localizeContext return ranked graph-backed context through a real daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const populated = await ops.populateSymbolGraph(mathFile, 100, 50, 20_000);
		expect(populated.status).toBe("succeeded");

		const result = await ops.localizeContext(root, "change the add function and its callers", { maxSymbols: 10, maxBytes: 20_000, maxDepth: 2 });
		expect(result.candidates.map((candidate) => candidate.name)).toContain("add");
		expect(result.candidates.some((candidate) => candidate.reasons.some((reason) => reason.kind === "graph-edge"))).toBe(true);
		expect(result.completeness.graph).toBe("complete");
	}, 20_000);

	it("populateSymbolGraph and workspaceMap resolve the project's own root directory to the project itself, not its parent", async () => {
		// Real, confirmed live bug: passing a project's own root directory (which has its own
		// .git right there) through the file-anchored resolution used elsewhere in this file
		// silently took dirname() first, resolving one level too high -- for a project nested
		// under a broader already-registered parent workspace, this mixed in every sibling
		// project's own graph with no error at all. Proven here by asserting the *directory*
		// path resolves to the exact same workspace (and populates the exact same graph) as an
		// explicit file already known to live inside it.
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const byDirectory = await ops.populateSymbolGraph(root, 100, 50, 20_000);
		expect(byDirectory.status).toBe("succeeded");
		if (byDirectory.status !== "succeeded") throw new Error(`expected succeeded job, got ${byDirectory.status}`);
		expect(byDirectory.result.filesProcessed).toBeGreaterThan(0);

		// The graph populated via the directory path must be the *same* project's graph: a
		// query anchored to a real file inside it must see real results, not an empty/wrong
		// workspace's graph.
		const map = await ops.workspaceMap(mathFile, 1_000, 1_000, 100, 1_000_000);
		expect(map.entries.map((entry) => entry.name)).toContain("add");
		expect(await ops.hasWarmIndex(root)).toBe(true);
	}, 20_000);

	it("populateSymbolGraph returns a pollable job immediately instead of blocking on a cold language server", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations("session-code-intelligence");
		const submitted = await ops.populateSymbolGraph(mathFile, 100, 50, 0);
		expect(["queued", "running"]).toContain(submitted.status);
		expect((await daemon.client.call("workspace.activeCachingJobs", { ownerId: "session-code-intelligence" })).jobs).toHaveLength(1);
		expect((await daemon.client.call("workspace.activeCachingJobs", { ownerId: "unrelated-session" })).jobs).toEqual([]);
		const final = await ops.jobStatus(submitted.id);
		expect(["running", "succeeded"]).toContain(final.status);
	}, 20_000);

	it("hasWarmIndex reports false before any query and true after, without itself causing a spawn", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		expect(await ops.hasWarmIndex(mathFile)).toBe(false);

		await ops.documentSymbols(mathFile);

		expect(await ops.hasWarmIndex(mathFile)).toBe(true);
	}, 20_000);
});
