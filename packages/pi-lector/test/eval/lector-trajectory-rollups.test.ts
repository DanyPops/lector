/**
 * Proves @danypops/pi-eval-harness's trajectory rollups (deriveTurns/summarizeRunUsage) work
 * correctly against a real captured Lector trace -- a genuinely spawned, scripted pi-lector
 * run, not a hand-authored AgentSessionEvent[] stand-in.
 *
 * A single scripted tool call genuinely produces two real turns, confirmed by inspecting the
 * actual captured event stream: turn 1 dispatches the scripted search_code call, turn 2 is the
 * faux provider's own final wrap-up reply once the script is exhausted (no further tool calls).
 * Exact token/cost figures are the faux provider's own internal accounting, not something
 * Lector's rollup logic should be coupled to -- this test asserts the real dependency (turns,
 * tool-call counts and names, and that usage totals equal the independently-summed per-turn
 * figures) rather than hard-coding brittle token counts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTurns, summarizeRunUsage } from "@danypops/pi-eval-harness";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";
import { captureLectorAgentTrace } from "./capture-lector-agent-trace.ts";

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-eval-rollup-fixture-"));
	writeFileSync(join(root, "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
	return root;
}

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("pi-eval-harness trajectory rollups against a real Lector trace", () => {
	it("derives the tool-dispatching turn plus the faux provider's wrap-up turn, with correct tool-call attribution", async () => {
		root = buildFixture();
		const daemon = await startIsolatedLectorDaemon();
		try {
			const events = await captureLectorAgentTrace({
				daemonEnv: daemon.env,
				script: [{ type: "toolCall", name: "search_code", arguments: { directory: root, query: "add", maxMatches: 10, maxBytes: 4096 } }],
			});

			const turns = deriveTurns(events);
			expect(turns).toHaveLength(2);
			expect(turns[0]?.toolNames).toEqual(["search_code"]);
			expect(turns[0]?.toolCalls).toBe(1);
			expect(turns[0]?.model).toBe("faux-1");
			// The wrap-up turn (no scripted step left to play) dispatches no further tool calls.
			expect(turns[1]?.toolCalls).toBe(0);
			expect(turns[1]?.toolNames).toEqual([]);

			const usage = summarizeRunUsage(turns);
			expect(usage.turns).toBe(2);
			expect(usage.toolCalls).toBe(1);
			expect(usage.toolNames).toEqual(["search_code"]);
			// Hand-computed from the two real turns independently of summarizeRunUsage's own
			// implementation, proving its reduction is a genuine sum, not a stray constant.
			expect(usage.tokensIn).toBe((turns[0]?.tokensIn ?? 0) + (turns[1]?.tokensIn ?? 0));
			expect(usage.tokensOut).toBe((turns[0]?.tokensOut ?? 0) + (turns[1]?.tokensOut ?? 0));
			expect(usage.cacheReadTokens).toBe((turns[0]?.cacheReadTokens ?? 0) + (turns[1]?.cacheReadTokens ?? 0));
			expect(usage.costUsd).toBe((turns[0]?.costUsd ?? 0) + (turns[1]?.costUsd ?? 0));
		} finally {
			await daemon.stop();
		}
	}, 30_000);
});
