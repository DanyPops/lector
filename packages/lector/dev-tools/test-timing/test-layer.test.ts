import { describe, expect, it } from "bun:test";
import { classifyTestLayer, testLayerIncludedInScope } from "./test-layer.ts";

describe("classifyTestLayer", () => {
	it("separates evaluation and performance workloads", () => {
		expect(classifyTestLayer("test/benchmarks/eval/ctf-corpus-rust.test.ts")).toBe("evaluation");
		expect(classifyTestLayer("test/performance/populate-symbol-graph-concurrency.perf.test.ts")).toBe("performance");
		expect(classifyTestLayer("test/performance/workload-replay.test.ts")).toBe("component");
	});

	it("classifies process boundaries separately from live integrations", () => {
		expect(classifyTestLayer("test/cli-symbol-annotations.test.ts")).toBe("system");
		expect(classifyTestLayer("test/code-intelligence/lsp/lsp-symbol-index.test.ts")).toBe("integration");
		expect(classifyTestLayer("test/typescript-reference-conformance.test.ts")).toBe("integration");
	});

	it("keeps harness tests and focused in-process tests in the lower layers", () => {
		expect(classifyTestLayer("dev-tools/test-timing/report.test.ts")).toBe("unit");
		expect(classifyTestLayer("test/symbol-graph/symbol-node-id.test.ts")).toBe("component");
	});
});

describe("testLayerIncludedInScope", () => {
	it("keeps measured workloads out of correctness scope", () => {
		expect(testLayerIncludedInScope("component", "correctness")).toBe(true);
		expect(testLayerIncludedInScope("evaluation", "correctness")).toBe(false);
		expect(testLayerIncludedInScope("performance", "correctness")).toBe(false);
		expect(testLayerIncludedInScope("evaluation", "evaluation")).toBe(true);
		expect(testLayerIncludedInScope("performance", "performance")).toBe(true);
	});
});
