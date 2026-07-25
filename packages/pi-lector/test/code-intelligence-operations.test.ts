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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorCodeIntelligenceOperations } from "../extension/src/code-intelligence-operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

/** A real-enough git repo fixture: workspaceForPath's project-root boundary is a real .git marker, not the filesystem root fallback. */
function buildProjectFixture(): { root: string; mathFile: string; brokenFile: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-code-intelligence-"));
	mkdirSync(join(root, ".git"));
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
	return { root, mathFile, brokenFile };
}

describe("Lector-backed code-intelligence operations", () => {
	it("documentSymbols lists a real file's declarations via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const symbols = await ops.documentSymbols(mathFile);

		const match = symbols.find((symbol) => symbol.name === "add");
		expect(match).toBeDefined();
		expect(match?.kind).toBe("function");
	}, 20_000);

	it("hover returns real type information for a known declaration", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		// Position on "add" in "export function add(...)" (0-indexed 16, 1-indexed 17).
		const hover = await ops.hover(mathFile, 1, 17);

		expect(hover).toBeDefined();
		expect(hover?.contents).toContain("add");
	}, 20_000);

	it("goToDefinition and findReferences resolve real positions, not placeholders", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const definitions = await ops.goToDefinition(mathFile, 1, 17);
		const references = await ops.findReferences(mathFile, 1, 17, true);

		expect(definitions.length).toBeGreaterThan(0);
		expect(definitions[0]?.path).toBe(mathFile);
		expect(references.length).toBeGreaterThan(0);
		expect(references.some((location) => location.path === mathFile)).toBe(true);
	}, 20_000);

	it("goToImplementation crosses an interface/implementation boundary that goToDefinition cannot", async () => {
		const daemon = startIsolatedLectorDaemon();
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

		expect(implementations.length).toBeGreaterThan(0);
		expect(implementations.every((location) => location.path === greeterFile)).toBe(true);
	}, 20_000);

	it("diagnostics reports a real type error via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, brokenFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const diagnostics = await ops.diagnostics(brokenFile);

		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]?.severity).toBe("error");
		expect(diagnostics[0]?.range.path).toBe(brokenFile);
	}, 20_000);

	it("prepareCallHierarchy, incomingCalls, and outgoingCalls resolve a real call relationship via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		// Position on "add" in "export function add(...)" (0-indexed 16, 1-indexed 17).
		const roots = await ops.prepareCallHierarchy(mathFile, 1, 17);
		expect(roots.length).toBeGreaterThan(0);
		expect(roots[0]?.name).toBe("add");

		const callers = await ops.incomingCalls(mathFile, 1, 17);
		expect(callers.some((call) => call.from.name === "addTwice")).toBe(true);

		// Position on "addTwice" in "export function addTwice(...)" (line 5: line 4 is the blank separator line).
		const callees = await ops.outgoingCalls(mathFile, 5, 17);
		expect(callees.some((call) => call.to.name === "add")).toBe(true);
	}, 20_000);

	it("populateSymbolGraph and reachableFrom answer a real multi-hop question via a running Lector daemon", async () => {
		const daemon = startIsolatedLectorDaemon();
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

	it("populateSymbolGraph returns a pollable job immediately instead of blocking on a cold language server", async () => {
		const daemon = startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const { root, mathFile } = buildProjectFixture();
		projectDir = root;

		const ops = createLectorCodeIntelligenceOperations();
		const submitted = await ops.populateSymbolGraph(mathFile, 100, 50, 0);
		expect(["queued", "running"]).toContain(submitted.status);
		const final = await ops.jobStatus(submitted.id);
		expect(["running", "succeeded"]).toContain(final.status);
	}, 20_000);

	it("hasWarmIndex reports false before any query and true after, without itself causing a spawn", async () => {
		const daemon = startIsolatedLectorDaemon();
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
