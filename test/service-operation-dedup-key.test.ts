/**
 * Checklist: "dedup/coalescing key includes every input that can change the
 * result" (task f3cdc40f). Oculus's LCS-BUG-77 shipped because a singleflight
 * key omitted an input (the scanner override) that changes the result,
 * silently collapsing two different requests onto one shared answer.
 *
 * Lector's service does not (yet) coalesce concurrent identical calls at
 * all -- doc 38db976d leaves the shared-cache question open for a later
 * step. This is a forward-guarding regression suite: it proves that two
 * concurrent operations differing only in a result-affecting field
 * (expectedHash, or workspaceId) are never merged or cross-contaminated
 * *today*, so that whenever coalescing is introduced, a dedup key that
 * forgets one of these fields will fail this suite immediately instead of
 * shipping silently.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { contentHashOf } from "../src/domain/content-hash.ts";
import { StaleExpectedHash, createLectorService } from "../src/service.ts";

describe("concurrent operations differing in a result-affecting field are never coalesced", () => {
	it("two concurrent edits racing on the same path with different expectedHash settle independently, not merged", async () => {
		const workspace = new InMemoryWorkspace();
		const service = createLectorService(new Map([["main", workspace]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "main", path: "a.txt", expectedHash: null, content: "base" });
		const baseHash = contentHashOf("base");

		const [first, second] = await Promise.allSettled([
			service.dispatch("workspace.exactEdit", { workspaceId: "main", path: "a.txt", expectedHash: baseHash, content: "writer one" }),
			service.dispatch("workspace.exactEdit", { workspaceId: "main", path: "a.txt", expectedHash: baseHash, content: "writer two" }),
		]);

		// Exactly one of the two racing edits (both reading the same expectedHash) commits;
		// the other observes the first's write and is rejected as stale. Neither outcome may
		// be silently merged into "both succeeded" or "neither succeeded".
		const outcomes = [first, second];
		const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleExpectedHash);

		const final = await service.dispatch("workspace.rawRead", { workspaceId: "main", path: "a.txt" });
		expect(["writer one", "writer two"]).toContain(final.content);
	});

	it("two concurrent reads on the same path but different workspaceId never cross-contaminate", async () => {
		const workspaceA = new InMemoryWorkspace();
		const workspaceB = new InMemoryWorkspace();
		const service = createLectorService(
			new Map([
				["a", workspaceA],
				["b", workspaceB],
			]),
		);
		await service.dispatch("workspace.exactEdit", { workspaceId: "a", path: "shared-name.txt", expectedHash: null, content: "A content" });
		await service.dispatch("workspace.exactEdit", { workspaceId: "b", path: "shared-name.txt", expectedHash: null, content: "B content" });

		const [readA, readB] = await Promise.all([
			service.dispatch("workspace.rawRead", { workspaceId: "a", path: "shared-name.txt" }),
			service.dispatch("workspace.rawRead", { workspaceId: "b", path: "shared-name.txt" }),
		]);

		expect(readA.content).toBe("A content");
		expect(readB.content).toBe("B content");
	});
});
