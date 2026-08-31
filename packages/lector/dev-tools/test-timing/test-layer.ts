export const TEST_LAYERS = ["unit", "component", "integration", "system", "evaluation", "performance"] as const;
export type TestLayer = (typeof TEST_LAYERS)[number];
export type TestScope = "all" | "correctness" | "evaluation" | "performance";

function normalizedPath(file: string): string {
	return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Classifies test cost by the broadest boundary exercised, using stable repository path conventions rather than observed duration. */
export function classifyTestLayer(file: string): TestLayer {
	const path = normalizedPath(file);
	if (path.includes("/dev-tools/") || path.startsWith("dev-tools/")) return "unit";
	if (path.includes("/test/benchmarks/eval/") || path.startsWith("test/benchmarks/eval/")) return "evaluation";
	if (path.endsWith(".perf.test.ts") || path.endsWith(".perf.test.tsx")) return "performance";
	if (/(?:^|\/)test\/(?:cli-|daemon-|packed-|vehicle-http-surface|package-install)/.test(path) || path.includes("/test/cli/") || path.startsWith("test/cli/"))
		return "system";
	if (
		path.includes("/code-intelligence/lsp/") ||
		path.includes("/test/code-intelligence/lsp/") ||
		/(?:^|\/)(?:service-|.*(?:conformance|reference)\.test\.)/.test(path) ||
		path.includes("language-server")
	)
		return "integration";
	return "component";
}

export function testLayerIncludedInScope(layer: TestLayer, scope: TestScope): boolean {
	if (scope === "all") return true;
	if (scope === "correctness") return layer !== "evaluation" && layer !== "performance";
	return layer === scope;
}
