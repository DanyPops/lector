/**
 * Proves @danypops/pi-eval-harness's tool-call matching operates correctly against Lector's own
 * real tool vocabulary -- the exact args/result shape search_code registers (extension/src/index.ts),
 * not Alef's generic examples. No adapter module exists on purpose: pi-eval-harness's ToolCall
 * matching already operates directly on a real AgentSessionEvent stream, so there is nothing
 * Lector-specific to translate -- this is the "thin adapter, not a reimplementation" the task's
 * own desired state calls for, proven with a fixture instead of built as unneeded wrapper code.
 */

import { describe, expect, it } from "bun:test";
import { all, expectsAll, expectsAny, extractToolExecutions } from "@danypops/pi-eval-harness";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TextSearchResult } from "../../../src/text-search/text-search-result.ts";

function searchCodeExecutionEvents(overrides: { query?: string; matchCount?: number } = {}): AgentSessionEvent[] {
	const query = overrides.query ?? "TODO";
	const matchCount = overrides.matchCount ?? 1;
	const result: TextSearchResult = {
		matches: Array.from({ length: matchCount }, (_, index) => ({
			path: "src/example.ts",
			lineNumber: index + 1,
			line: `// ${query} fix this`,
			matchStart: 3,
			matchEnd: 3 + query.length,
		})),
		truncated: false,
	};
	return [
		{
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "search_code",
			args: { directory: "/repo/src", query, maxMatches: 20, maxBytes: 4096 },
		},
		{ type: "tool_execution_end", toolCallId: "call-1", toolName: "search_code", result, isError: false },
	];
}

describe("pi-eval-harness matching against Lector's real search_code tool shape", () => {
	it("extracts one completed search_code execution with its real args and result", () => {
		const executions = extractToolExecutions(searchCodeExecutionEvents());
		expect(executions).toHaveLength(1);
		expect(executions[0]?.toolName).toBe("search_code");
		expect(executions[0]?.args).toEqual({ directory: "/repo/src", query: "TODO", maxMatches: 20, maxBytes: 4096 });
	});

	it("matches on search_code's own arbitrary target arg name (query), not one of pi-eval-harness's named fields", async () => {
		const executions = extractToolExecutions(searchCodeExecutionEvents({ query: "FIXME" }));
		const checker = expectsAll([{ tool: "search_code", target: { query: "FIXME" } }]);
		expect(await checker.check({ executions })).toEqual({ pass: true, score: 1, errors: [] });
	});

	it("fails a mismatched target with a real, readable error naming the expectation", async () => {
		const executions = extractToolExecutions(searchCodeExecutionEvents({ query: "TODO" }));
		const checker = expectsAll([{ tool: "search_code", target: { query: "FIXME" } }]);
		const result = await checker.check({ executions });
		expect(result.pass).toBe(false);
		expect(result.errors).toEqual(["Expected search_code on query=FIXME"]);
	});

	it("matches produces against a real, structured TextSearchResult, not a string result", async () => {
		const executions = extractToolExecutions(searchCodeExecutionEvents({ query: "TODO" }));
		const checker = expectsAll([{ tool: "search_code", produces: "example.ts" }]);
		expect(await checker.check({ executions })).toEqual({ pass: true, score: 1, errors: [] });
	});

	it("satisfies expectsAny across Lector's own search_code/find_symbols tool names", async () => {
		const executions = extractToolExecutions(searchCodeExecutionEvents());
		const checker = expectsAny([{ tool: "find_symbols" }, { tool: "search_code" }]);
		expect(await checker.check({ executions })).toEqual({ pass: true, score: 1, errors: [] });
	});

	it("composes an AND-of-two-checkers over a real run via all()", async () => {
		const executions = extractToolExecutions(searchCodeExecutionEvents({ query: "TODO" }));
		const combined = all(expectsAll([{ tool: "search_code" }]), expectsAll([{ tool: "search_code", target: { query: "TODO" } }]));
		expect(await combined.check({ executions })).toEqual({ pass: true, score: 1, errors: [] });
	});
});
