import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";
import { InMemoryMutationHistory } from "../../src/mutation-history/in-memory-mutation-history.ts";
import type { WorkspaceId } from "../../src/service/errors.ts";
import { MutationHistoryCoordinator } from "../../src/service/mutation-history-handlers.ts";
import { InMemoryWorkspace } from "../../src/workspace/in-memory-workspace.ts";

function fixture(maxEntriesPerFile = 50) {
	const workspaceA = new InMemoryWorkspace();
	const workspaceB = new InMemoryWorkspace();
	const registry = new Map([
		["ws-a" as WorkspaceId, { port: workspaceA, origin: "local" as const }],
		["ws-b" as WorkspaceId, { port: workspaceB, origin: "local" as const }],
	]);
	const coordinator = new MutationHistoryCoordinator({ registry, createStore: () => new InMemoryMutationHistory(maxEntriesPerFile) });
	return { workspaceA, workspaceB, registry, coordinator };
}

async function recordedTransaction(fx: ReturnType<typeof fixture>, path = "a.txt"): Promise<string> {
	await fx.workspaceA.writeEntry(path, null, "after");
	return fx.coordinator.recordTransaction("ws-a" as WorkspaceId, "rename", [{ path, beforeContent: "before", afterHash: contentHashOf("after") }]);
}

describe("mutation transaction lookup", () => {
	it("returns ready and stale outcomes", async () => {
		const fx = fixture();
		const transactionId = await recordedTransaction(fx);

		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, { workspaceId: "ws-a" as WorkspaceId, transactionId }),
		).resolves.toMatchObject({ status: "ready", transactionId });

		await fx.workspaceA.writeEntry("a.txt", contentHashOf("after"), "newer");
		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, { workspaceId: "ws-a" as WorkspaceId, transactionId }),
		).resolves.toMatchObject({ status: "stale", transactionId, stalePaths: ["a.txt"] });
	});

	it("distinguishes evicted, wrong-workspace, and unknown ids", async () => {
		const fx = fixture(1);
		const evictedId = await recordedTransaction(fx);
		await fx.workspaceA.writeEntry("a.txt", contentHashOf("after"), "second");
		await fx.coordinator.recordTransaction("ws-a" as WorkspaceId, "rename", [{ path: "a.txt", beforeContent: "after", afterHash: contentHashOf("second") }]);

		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, { workspaceId: "ws-a" as WorkspaceId, transactionId: evictedId }),
		).resolves.toEqual({ status: "evicted", transactionId: evictedId });
		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, { workspaceId: "ws-b" as WorkspaceId, transactionId: evictedId }),
		).resolves.toEqual({ status: "wrong-workspace", transactionId: evictedId });
		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, {
				workspaceId: "ws-a" as WorkspaceId,
				transactionId: "never-recorded",
			}),
		).resolves.toEqual({ status: "unknown", transactionId: "never-recorded" });
	});

	it("bounds transaction ownership receipts", async () => {
		const fx = fixture(1);
		const firstId = await fx.coordinator.recordTransaction("ws-a" as WorkspaceId, "rename", [{ path: "a.txt", beforeContent: null, afterHash: null }]);
		let latestId = firstId;
		for (let index = 0; index < 10_000; index += 1) {
			latestId = await fx.coordinator.recordTransaction("ws-a" as WorkspaceId, "rename", [{ path: "a.txt", beforeContent: null, afterHash: null }]);
		}

		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, { workspaceId: "ws-a" as WorkspaceId, transactionId: firstId }),
		).resolves.toEqual({ status: "unknown", transactionId: firstId });
		await expect(
			fx.coordinator.handlers["workspace.mutationTransaction"](fx.registry, { workspaceId: "ws-b" as WorkspaceId, transactionId: latestId }),
		).resolves.toEqual({ status: "wrong-workspace", transactionId: latestId });
	});
});
