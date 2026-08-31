import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { contentHashOf } from "../src/content-identity/content-hash.ts";
import { InMemoryMutationHistory } from "../src/mutation-history/in-memory-mutation-history.ts";
import { ImpactAnalysisRequiresFreshGraph } from "../src/service/impact-analysis-handler.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(...args: string[]): void {
	if (!root) throw new Error("fixture missing");
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function buildFixture(): { root: string; calculate: string } {
	const fixture = mkdtempSync(join(tmpdir(), "lector-impact-analysis-"));
	root = fixture;
	mkdirSync(join(fixture, "src"));
	mkdirSync(join(fixture, "test"));
	const calculate = join(fixture, "src", "calculate.ts");
	writeFileSync(calculate, "export function calculate(value: number): number { return value + 1; }\n");
	writeFileSync(join(fixture, "src", "checkout.ts"), 'import { calculate } from "./calculate";\nexport function checkout(): number { return calculate(1); }\n');
	writeFileSync(
		join(fixture, "test", "checkout.test.ts"),
		'import { checkout } from "../src/checkout";\nexport function checkoutTest(): boolean { return checkout() === 2; }\n',
	);
	writeFileSync(
		join(fixture, "test", "manual.spec.ts"),
		'import { calculate } from "../src/calculate";\nexport function manualTest(): boolean { return true; }\n',
	);
	writeFileSync(join(fixture, "test", "coverage.spec.ts"), "export function coverageTest(): boolean { return true; }\n");
	writeFileSync(join(fixture, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
	writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	git("init", "-q");
	git("config", "user.email", "fixture@lector.invalid");
	git("config", "user.name", "Lector Fixture");
	git("add", "-A");
	git("commit", "-q", "-m", "baseline");
	return { root: fixture, calculate };
}

describe("workspace.impactAnalysis", () => {
	it("maps a working-tree diff to callers, tests, package boundaries, and diagnostics", async () => {
		const fixture = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "calculate", seedFile: "src/calculate.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 100 });
		writeFileSync(fixture.calculate, "export function calculate(value: number): number { return value + 2; }\n");

		const result = await service.dispatch("workspace.impactAnalysis", {
			workspaceId,
			source: { kind: "git", ref: "HEAD" },
			maxDepth: 3,
			autoPopulate: true,
			maxFiles: 100,
			maxSymbolsPerFile: 100,
			maxNodes: 100,
			maxEdges: 1_000,
			maxBytes: 100_000,
			deadlineMs: 20_000,
			coverage: [{ testPath: "test/coverage.spec.ts", coveredPaths: ["src/calculate.ts"] }],
		});

		expect(result.changedSymbols.map(({ symbol }) => symbol.name)).toContain("calculate");
		expect(result.impactedSymbols.map(({ symbol }) => symbol.name)).toContain("checkout");
		expect(result.relatedTests.some(({ symbol, evidence }) => symbol.location.path.endsWith("checkout.test.ts") && evidence.kind === "semantic-edge")).toBe(
			true,
		);
		expect(result.relatedTests.some(({ symbol, evidence }) => symbol.location.path.endsWith("manual.spec.ts") && evidence.kind === "import-heuristic")).toBe(
			true,
		);
		expect(result.relatedTests.some(({ symbol, evidence }) => symbol.location.path.endsWith("coverage.spec.ts") && evidence.kind === "coverage")).toBe(true);
		expect(result.packageBoundaries).toEqual([expect.objectContaining({ path: fixture.root, marker: "package.json", changedPaths: [fixture.calculate] })]);
		expect(result.diagnostics).toEqual([expect.objectContaining({ path: fixture.calculate, unavailable: false })]);
		const bounded = await service.dispatch("workspace.impactAnalysis", {
			workspaceId,
			source: { kind: "git", ref: "HEAD" },
			autoPopulate: true,
			maxDepth: 3,
			maxFiles: 100,
			maxSymbolsPerFile: 100,
			maxNodes: 100,
			maxEdges: 1_000,
			maxBytes: 1_000,
			deadlineMs: 20_000,
		});
		expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(1_000);
		expect(bounded.truncated).toBe(true);
	}, 30_000);

	it("compares affected-file diagnostics against a git baseline ref", async () => {
		const fixture = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "calculate", seedFile: "src/calculate.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 100 });
		writeFileSync(fixture.calculate, 'export function calculate(value: number): number { return "bad"; }\n');

		const delta = await service.dispatch("workspace.diagnosticDelta", {
			workspaceId,
			source: { kind: "git", ref: "HEAD" },
			autoPopulate: true,
			maxDepth: 2,
			maxFiles: 100,
			maxSymbolsPerFile: 100,
			maxNodes: 100,
			maxEdges: 1_000,
			maxResults: 100,
			maxBytes: 100_000,
			deadlineMs: 30_000,
		});
		expect(delta.source).toEqual({ kind: "git", ref: "HEAD" });
		expect(delta.introduced.some(({ code, range }) => code === 2322 && range.path === fixture.calculate)).toBe(true);
		expect(delta.affectedPaths).toContain(join(fixture.root, "src", "checkout.ts"));
		expect(delta.completeness).toBe("complete");
	}, 60_000);

	it("preserves before and after identities across a rename", async () => {
		const fixture = buildFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "calculate", seedFile: "src/calculate.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 100 });
		const renamed = join(fixture.root, "src", "math.ts");
		renameSync(fixture.calculate, renamed);
		const checkout = join(fixture.root, "src", "checkout.ts");
		writeFileSync(checkout, (await Bun.file(checkout).text()).replace('./calculate"', './math"'));
		git("add", "-A");

		const result = await service.dispatch("workspace.impactAnalysis", {
			workspaceId,
			source: { kind: "git", ref: "HEAD" },
			autoPopulate: true,
			maxDepth: 2,
			maxFiles: 100,
			maxSymbolsPerFile: 100,
			maxNodes: 100,
			maxEdges: 1_000,
			maxBytes: 100_000,
			deadlineMs: 20_000,
		});
		const identities = result.changedSymbols.filter(({ symbol }) => symbol.name === "calculate");
		expect(identities.map(({ side, symbol }) => ({ side, path: symbol.location.path }))).toEqual([
			{ side: "before", path: fixture.calculate },
			{ side: "after", path: renamed },
		]);
		expect(result.identityCompleteness).toBe("complete");
	}, 30_000);

	it("fails closed when the requested graph generation is unavailable", async () => {
		const fixture = buildFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		await expect(
			service.dispatch("workspace.impactAnalysis", {
				workspaceId,
				source: { kind: "git", ref: "HEAD" },
				maxDepth: 2,
				maxFiles: 100,
				maxSymbolsPerFile: 100,
				maxNodes: 100,
				maxEdges: 1_000,
				maxBytes: 100_000,
				deadlineMs: 20_000,
			}),
		).rejects.toBeInstanceOf(ImpactAnalysisRequiresFreshGraph);
	}, 20_000);

	it("accepts a recorded mutation transaction as the change source", async () => {
		const fixture = buildFixture();
		const history = new InMemoryMutationHistory();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createMutationHistory: () => history,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixture.root });
		await service.dispatch("workspace.findSymbols", { workspaceId, query: "calculate", seedFile: "src/calculate.ts" });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 100 });
		const beforeContent = "export function calculate(value: number): number { return value + 1; }\n";
		await history.record({
			path: fixture.calculate,
			operation: "exactEdit",
			beforeContent,
			beforeHash: contentHashOf(beforeContent),
			afterHash: contentHashOf(beforeContent.replace("+ 1", "+ 2")),
			transactionId: "tx-impact",
		});

		const result = await service.dispatch("workspace.impactAnalysis", {
			workspaceId,
			source: { kind: "mutation", transactionId: "tx-impact" },
			maxDepth: 2,
			autoPopulate: true,
			maxFiles: 100,
			maxSymbolsPerFile: 100,
			maxNodes: 100,
			maxEdges: 1_000,
			maxBytes: 100_000,
			deadlineMs: 20_000,
		});
		expect(result.source).toEqual({ kind: "mutation", transactionId: "tx-impact" });
		expect(result.changedSymbols.map(({ symbol }) => symbol.name)).toContain("calculate");
	}, 30_000);
});
