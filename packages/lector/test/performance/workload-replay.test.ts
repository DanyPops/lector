import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { generateTypeScriptWorkloadCorpus } from "../../benchmarks/harness/workload-corpus.ts";
import { replayWorkload, replayWorkloadStep, type WorkloadStep } from "../../benchmarks/harness/workload-replay.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../../src/service.ts";

describe("replayWorkloadStep", () => {
	it("reports a step as passed with a real, trustworthy timing when verify() accepts the result", async () => {
		const step: WorkloadStep<number> = {
			name: "trivial success",
			sampleIterations: 3,
			run: async () => 42,
			verify: (result) => result === 42,
		};

		const replayed = await replayWorkloadStep(step);

		expect(replayed.passed).toBe(true);
		expect(replayed.run).toBeDefined();
		expect(replayed.run?.completedSampleIterations).toBe(3);
	});

	it("reports a step as failed with NO timing attached when verify() rejects the result -- an untrusted number must never look valid", async () => {
		const step: WorkloadStep<number> = {
			name: "wrong result",
			sampleIterations: 3,
			run: async () => 1,
			verify: (result) => result === 42,
		};

		const replayed = await replayWorkloadStep(step);

		expect(replayed.passed).toBe(false);
		expect(replayed.run).toBeUndefined();
	});

	it("fails the whole step if even one sample among several fails verification, not just the first", async () => {
		let call = 0;
		const step: WorkloadStep<number> = {
			name: "flaky",
			sampleIterations: 4,
			run: async () => {
				call += 1;
				return call; // 1, 2, 3, 4 -- verify only accepts even numbers
			},
			verify: (result) => result % 2 === 0,
		};

		const replayed = await replayWorkloadStep(step);

		expect(replayed.passed).toBe(false);
		expect(replayed.run).toBeUndefined();
	});

	it("propagates a real error thrown by the step's own run(), distinct from a verify() rejection", async () => {
		const step: WorkloadStep<number> = {
			name: "throws",
			run: async () => {
				throw new Error("real step failure");
			},
			verify: () => true,
		};

		await expect(replayWorkloadStep(step)).rejects.toThrow("real step failure");
	});
});

describe("replayWorkload", () => {
	it("runs every step and reports allPassed: true only when every step passed", async () => {
		const passing: WorkloadStep<number> = { name: "a", run: async () => 1, verify: (r) => r === 1 };
		const failing: WorkloadStep<number> = { name: "b", run: async () => 2, verify: (r) => r === 999 };

		const onlyPassing = await replayWorkload([passing]);
		expect(onlyPassing.allPassed).toBe(true);

		const mixed = await replayWorkload([passing, failing]);
		expect(mixed.allPassed).toBe(false);
		expect(mixed.steps.map((s) => s.passed)).toEqual([true, false]);
	});
});

describe("replayWorkload against real Lector operations over a generated corpus", () => {
	let corpusRoot: string | undefined;
	let service: LectorService | undefined;

	afterEach(async () => {
		await service?.close();
		service = undefined;
		if (corpusRoot) rmSync(corpusRoot, { recursive: true, force: true });
		corpusRoot = undefined;
	});

	it("exercises raw read, ripgrep search, full population, and localizeContext against one real generated corpus, all verified before their timings are trusted", async () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 7, fileCount: 6, shape: "chain" });
		corpusRoot = corpus.rootPath;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: corpus.rootPath });
		const firstFile = corpus.files[0];
		const lastFile = corpus.files[corpus.files.length - 1];
		if (!firstFile || !lastFile) throw new Error("corpus generation is expected to always produce at least two files here");

		const steps: WorkloadStep[] = [
			{
				name: "raw-read",
				run: async () => service?.dispatch("workspace.rawRead", { workspaceId, path: firstFile.relativePath }),
				verify: (result) =>
					typeof (result as { content: string }).content === "string" && (result as { content: string }).content.includes(firstFile.exportedSymbol),
			},
			{
				name: "ripgrep-search",
				run: async () => service?.dispatch("workspace.searchText", { workspaceId, query: lastFile.exportedSymbol, maxMatches: 10, maxBytes: 10_000 }),
				verify: (result) => (result as { matches: readonly unknown[] }).matches.length > 0,
			},
			{
				name: "populate-symbol-graph-full",
				run: async () => {
					await service?.dispatch("workspace.findSymbols", { workspaceId, query: firstFile.exportedSymbol, seedFile: firstFile.relativePath });
					return service?.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });
				},
				verify: (result) => (result as { filesProcessed: number }).filesProcessed === corpus.files.length,
			},
			{
				name: "localize-context-warm",
				run: async () =>
					service?.dispatch("workspace.localizeContext", {
						workspaceId,
						query: `understand ${firstFile.exportedSymbol}`,
						maxSymbols: 5,
						maxBytes: 10_000,
						maxDepth: 2,
					}),
				verify: (result) => (result as { candidates: readonly { name: string }[] }).candidates.some((c) => c.name === firstFile.exportedSymbol),
			},
		];

		const report = await replayWorkload(steps);

		expect(report.allPassed).toBe(true);
		for (const step of report.steps) {
			expect(step.passed).toBe(true);
			expect(step.run?.wallTimeStatistics?.count).toBeGreaterThan(0);
		}
	}, 30_000);

	it("exercises workspace_map density, delta re-population, an exact large-file edit, and a mixed search->edit->verify trace against one real corpus", async () => {
		const corpus = generateTypeScriptWorkloadCorpus({ seed: 11, fileCount: 8, shape: "chain", maxBytesPerFile: 20_000 });
		corpusRoot = corpus.rootPath;
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const activeService = service;
		const { workspaceId } = await activeService.dispatch("workspace.registerPath", { path: corpus.rootPath });
		const firstFile = corpus.files[0];
		if (!firstFile) throw new Error("corpus generation is expected to always produce at least one file here");
		await activeService.dispatch("workspace.findSymbols", { workspaceId, query: firstFile.exportedSymbol, seedFile: firstFile.relativePath });
		await activeService.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 });

		const steps: WorkloadStep[] = [
			{
				name: "workspace-map-density",
				run: async () => activeService.dispatch("workspace.map", { workspaceId, maxNodes: 100, maxEdges: 200, maxEntries: 20, maxBytes: 20_000 }),
				verify: (result) => (result as { entries: readonly unknown[] }).entries.length > 0,
			},
			{
				name: "populate-symbol-graph-delta-repeat",
				run: async () => activeService.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 100, maxSymbolsPerFile: 50 }),
				verify: (result) =>
					(result as { completeness: string; filesProcessed: number }).completeness === "complete" &&
					(result as { filesProcessed: number }).filesProcessed === corpus.files.length,
			},
			{
				name: "exact-large-file-edit",
				run: async () => {
					const before = await activeService.dispatch("workspace.rawRead", { workspaceId, path: firstFile.relativePath });
					const newContent = `${before.content}\nexport const editedMarker = "workload-replay";\n`;
					await activeService.dispatch("workspace.exactEdit", { workspaceId, path: firstFile.relativePath, expectedHash: before.hash, content: newContent });
					return activeService.dispatch("workspace.rawRead", { workspaceId, path: firstFile.relativePath });
				},
				verify: (result) => (result as { content: string }).content.includes("editedMarker"),
			},
			{
				name: "mixed-search-then-edit-then-verify",
				run: async (): Promise<boolean> => {
					const found = await activeService.dispatch("workspace.searchText", { workspaceId, query: "editedMarker", maxMatches: 10, maxBytes: 10_000 });
					const matchedPath = found.matches[0]?.path;
					if (!matchedPath) return false;
					const read = await activeService.dispatch("workspace.rawRead", { workspaceId, path: matchedPath });
					return read.content.includes("editedMarker");
				},
				verify: (verified) => verified === true,
			},
		];

		const report = await replayWorkload(steps);

		expect(report.allPassed).toBe(true);
		for (const step of report.steps) {
			expect(step.passed).toBe(true);
			expect(step.run?.wallTimeStatistics?.count).toBeGreaterThan(0);
		}
	}, 30_000);
});
