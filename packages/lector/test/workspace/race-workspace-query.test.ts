import { describe, expect, it } from "bun:test";
import { raceWorkspaceQuery } from "../../src/workspace/race-workspace-query.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("raceWorkspaceQuery", () => {
	it("returns a ready outcome when the query finishes within the budget", async () => {
		const outcome = await raceWorkspaceQuery("ws-1", async () => "real result", 200, "still loading");
		expect(outcome).toEqual({ workspaceId: "ws-1", status: "ready", result: "real result" });
	});

	it("returns a loading outcome, not an empty/silent result, when the budget is exceeded", async () => {
		const outcome = await raceWorkspaceQuery(
			"ws-1",
			async () => {
				await delay(200);
				return "real result";
			},
			20,
			"symbol index is still warming up",
		);
		expect(outcome.status).toBe("loading");
		if (outcome.status !== "loading") throw new Error("unreachable");
		expect(outcome.message).toBe("symbol index is still warming up");
	});

	it("returns an error outcome for this workspace alone, never throwing, when the query rejects", async () => {
		const outcome = await raceWorkspaceQuery(
			"ws-1",
			async () => {
				throw new Error("unsupported language");
			},
			200,
			"still loading",
		);
		expect(outcome).toEqual({ workspaceId: "ws-1", status: "error", message: "unsupported language" });
	});

	it("the underlying work keeps running after a timeout is reported -- a real background completion, not an abandoned call", async () => {
		let completed = false;
		const outcome = await raceWorkspaceQuery(
			"ws-1",
			async () => {
				await delay(30);
				completed = true;
				return "late result";
			},
			10,
			"still loading",
		);
		expect(outcome.status).toBe("loading");
		expect(completed).toBe(false); // not yet, at the moment "loading" was reported, checked before narrowing
		await delay(50);
		expect(completed).toBe(true); // the real work finished on its own, unaffected by the earlier timeout
	});
});
