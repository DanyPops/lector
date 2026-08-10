/**
 * Semantic rename and reference-based file rename must both be recorded as grouped mutation
 * transactions -- the live stress-test gap this fixes: mutation_history list showed nothing for
 * either rename, only single-file writes ever got recorded. Runs against a real, live
 * typescript-language-server, the same convention service-rename.test.ts/
 * service-reference-based-rename.test.ts already use.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService, MutationTransactionNotFound, MutationTransactionRevertStale } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-mutation-transaction-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(root, "src", "consumer.ts"), 'import { add } from "./math";\n\nexport function sum(): number {\n\treturn add(1, 2);\n}\n');
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return root;
}

async function buildService(): Promise<{ service: LectorService; workspaceId: string }> {
	const service = createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
	});
	const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot as string });
	return { service, workspaceId };
}

describe("createLectorService's rename mutation transactions", () => {
	it("records a semantic rename as one grouped transaction spanning every touched file", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");
		const consumerPath = join(fixtureRoot, "src", "consumer.ts");
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: consumerPath });

		await service.dispatch("workspace.rename", { workspaceId: built.workspaceId, path: mathPath, line: 1, character: 17, newName: "sum" });

		const mathHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		const consumerHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: consumerPath, maxResults: 10 });
		expect(mathHistory.entries).toHaveLength(1);
		expect(consumerHistory.entries).toHaveLength(1);
		expect(mathHistory.entries[0]?.operation).toBe("rename");

		const transactionId = mathHistory.entries[0]?.transactionId;
		expect(transactionId).not.toBeNull();
		expect(consumerHistory.entries[0]?.transactionId).toBe(transactionId as string);

		const preview = await service.dispatch("workspace.mutationTransaction", { workspaceId: built.workspaceId, transactionId: transactionId as string });
		expect(preview.entries.map((entry) => entry.path).sort()).toEqual([consumerPath, mathPath].sort());
	}, 20_000);

	it("reverts a whole rename transaction atomically, restoring every file's exact prior content", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");
		const consumerPath = join(fixtureRoot, "src", "consumer.ts");
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: consumerPath });
		const originalMath = readFileSync(mathPath, "utf8");
		const originalConsumer = readFileSync(consumerPath, "utf8");

		await service.dispatch("workspace.rename", { workspaceId: built.workspaceId, path: mathPath, line: 1, character: 17, newName: "sum" });
		const history = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		const transactionId = history.entries[0]?.transactionId as string;

		const outcome = await service.dispatch("workspace.revertMutationTransaction", { workspaceId: built.workspaceId, transactionId });
		expect(outcome.reverted.map((entry) => entry.path).sort()).toEqual([consumerPath, mathPath].sort());

		expect(readFileSync(mathPath, "utf8")).toBe(originalMath);
		expect(readFileSync(consumerPath, "utf8")).toBe(originalConsumer);

		// The revert is itself a further-revertible transaction.
		const revertHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		expect(revertHistory.entries.find((entry) => entry.operation === "revert")).toBeDefined();
	}, 20_000);

	it("refuses to revert the whole transaction when even one member file has changed since, touching nothing", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");
		const consumerPath = join(fixtureRoot, "src", "consumer.ts");
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: consumerPath });

		await service.dispatch("workspace.rename", { workspaceId: built.workspaceId, path: mathPath, line: 1, character: 17, newName: "sum" });
		const history = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		const transactionId = history.entries[0]?.transactionId as string;
		const renamedMath = readFileSync(mathPath, "utf8");

		// A later, unrelated edit lands on consumer.ts after the rename.
		writeFileSync(consumerPath, "// someone else's unrelated change\n");

		await expect(service.dispatch("workspace.revertMutationTransaction", { workspaceId: built.workspaceId, transactionId })).rejects.toBeInstanceOf(
			MutationTransactionRevertStale,
		);

		// Neither file was touched by the refused revert.
		expect(readFileSync(consumerPath, "utf8")).toBe("// someone else's unrelated change\n");
		expect(readFileSync(mathPath, "utf8")).toBe(renamedMath);
	}, 20_000);

	it("rejects a transaction id that was never recorded", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;

		await expect(service.dispatch("workspace.mutationTransaction", { workspaceId: built.workspaceId, transactionId: "never-recorded" })).rejects.toBeInstanceOf(
			MutationTransactionNotFound,
		);
		await expect(
			service.dispatch("workspace.revertMutationTransaction", { workspaceId: built.workspaceId, transactionId: "never-recorded" }),
		).rejects.toBeInstanceOf(MutationTransactionNotFound);
	}, 20_000);

	it("records reference-based rename as one grouped transaction covering the move and every rewritten importer", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");
		const consumerPath = join(fixtureRoot, "src", "consumer.ts");
		const arithmeticPath = join(fixtureRoot, "src", "arithmetic.ts");
		const originalMath = readFileSync(mathPath, "utf8");
		const originalConsumer = readFileSync(consumerPath, "utf8");
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: consumerPath });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId: built.workspaceId, maxFiles: 500, maxSymbolsPerFile: 100 });

		const outcome = await service.dispatch("workspace.referenceBasedRename", {
			workspaceId: built.workspaceId,
			fromPath: mathPath,
			toPath: arithmeticPath,
			maxFiles: 500,
			maxSymbolsPerFile: 100,
		});
		expect(outcome.movedTo).toBe(arithmeticPath);
		expect(outcome.filesUpdated).toEqual([consumerPath]);

		const movedHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		const createdHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: arithmeticPath, maxResults: 10 });
		const consumerHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: consumerPath, maxResults: 10 });
		const transactionId = movedHistory.entries[0]?.transactionId;
		expect(transactionId).not.toBeNull();
		expect(createdHistory.entries[0]?.transactionId).toBe(transactionId as string);
		expect(consumerHistory.entries[0]?.transactionId).toBe(transactionId as string);

		const reverted = await service.dispatch("workspace.revertMutationTransaction", { workspaceId: built.workspaceId, transactionId: transactionId as string });
		expect(reverted.reverted.map((entry) => entry.path).sort()).toEqual([arithmeticPath, consumerPath, mathPath].sort());
		expect(readFileSync(mathPath, "utf8")).toBe(originalMath);
		expect(readFileSync(consumerPath, "utf8")).toBe(originalConsumer);
	}, 20_000);
});
