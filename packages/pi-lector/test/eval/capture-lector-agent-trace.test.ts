/**
 * Proves the real end-to-end wiring: a genuinely spawned `pi` process, running the real
 * pi-lector extension, scripted (no live LLM) to call search_code against a real isolated
 * Lector daemon -- and that the captured trace scores correctly through
 * @danypops/pi-eval-harness's real matching logic, not a synthetic stand-in.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectsAll, extractToolExecutions } from "@danypops/pi-eval-harness";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";
import { captureLectorAgentTrace } from "./capture-lector-agent-trace.ts";

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-eval-fixture-"));
	writeFileSync(join(root, "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
	return root;
}

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("captureLectorAgentTrace against a real spawned pi-lector extension", () => {
	it("captures a real search_code call and scores it through pi-eval-harness's matching", async () => {
		root = buildFixture();
		const daemon = await startIsolatedLectorDaemon();
		try {
			const events = await captureLectorAgentTrace({
				daemonEnv: daemon.env,
				script: [
					{
						type: "toolCall",
						name: "search_code",
						arguments: { directory: root, query: "add", maxMatches: 10, maxBytes: 4096 },
					},
				],
			});

			const executions = extractToolExecutions(events);
			expect(executions).toHaveLength(1);
			expect(executions[0]?.toolName).toBe("search_code");
			expect(executions[0]?.isError).toBe(false);

			const checker = expectsAll([{ tool: "search_code", target: { directory: root, query: "add" }, produces: "math.ts" }]);
			expect(await checker.check({ executions })).toEqual({ pass: true, score: 1, errors: [] });
		} finally {
			await daemon.stop();
		}
	}, 30_000);
});
