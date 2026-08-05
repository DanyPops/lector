/**
 * Service-level wiring for workspace.mutationHistory/revertMutation: every successful
 * exactEdit/lineEdit/applyPatch is recorded, and a revert restores exactly the pre-mutation
 * content, guarded the same way every other Lector write is -- refuses over an intervening
 * change instead of silently clobbering it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { contentHashOf } from "../src/content-identity/content-hash.ts";
import { lineHashOf } from "../src/content-identity/line-hash.ts";
import { createLectorService, type LectorService, MutationEntryNotFound, MutationRevertStale } from "../src/service.ts";

let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
});

describe("createLectorService's mutation history and revert", () => {
	it("records exactEdit, lineEdit, and applyPatch, newest first", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));

		await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: null, content: "line one\n" });
		await service.dispatch("workspace.lineEdit", {
			workspaceId: "ws",
			path: "a.txt",
			edits: [{ kind: "insertAfter", atLine: 1, expectedHash: lineHashOf("line one"), lines: ["line two"] }],
		});

		const { entries } = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		expect(entries.map((entry) => entry.operation)).toEqual(["lineEdit", "exactEdit"]);
		expect(entries[1]?.beforeContent).toBeNull();
	});

	it("reverts exactEdit back to the file's exact prior content", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: null, content: "v1" });
		const second = await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: contentHashOf("v1"), content: "v2" });
		const { entries } = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		const secondEntry = entries.find((entry) => entry.afterHash === second.newHash);
		expect(secondEntry).toBeDefined();

		const reverted = await service.dispatch("workspace.revertMutation", { workspaceId: "ws", entryId: secondEntry?.id as string });

		expect(reverted).toEqual({ path: "a.txt", newHash: contentHashOf("v1") });
		await expect(service.dispatch("workspace.rawRead", { workspaceId: "ws", path: "a.txt" })).resolves.toMatchObject({ content: "v1" });
	});

	it("reverts a create back to nonexistence -- the file is genuinely gone, not emptied", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));
		const created = await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: null, content: "v1" });
		const { entries } = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		const createEntry = entries.find((entry) => entry.afterHash === created.newHash);

		const reverted = await service.dispatch("workspace.revertMutation", { workspaceId: "ws", entryId: createEntry?.id as string });

		expect(reverted).toEqual({ path: "a.txt", newHash: null });
		await expect(service.dispatch("workspace.rawRead", { workspaceId: "ws", path: "a.txt" })).rejects.toThrow();
	});

	it("a revert is itself a real, further-revertible mutation -- 'U undoes U'", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: null, content: "v1" });
		const second = await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: contentHashOf("v1"), content: "v2" });
		const beforeRevert = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		const secondEntryId = beforeRevert.entries.find((entry) => entry.afterHash === second.newHash)?.id as string;
		const revertOutcome = await service.dispatch("workspace.revertMutation", { workspaceId: "ws", entryId: secondEntryId });

		const afterRevert = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		const revertEntry = afterRevert.entries.find((entry) => entry.operation === "revert");
		expect(revertEntry).toBeDefined();

		const undoTheUndo = await service.dispatch("workspace.revertMutation", { workspaceId: "ws", entryId: revertEntry?.id as string });

		expect(undoTheUndo).toEqual({ path: "a.txt", newHash: revertOutcome.newHash === null ? null : contentHashOf("v2") });
		await expect(service.dispatch("workspace.rawRead", { workspaceId: "ws", path: "a.txt" })).resolves.toMatchObject({ content: "v2" });
	});

	it("refuses a revert when the file has changed since -- never silently clobbers the newer change", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));
		const first = await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: null, content: "v1" });
		const { entries } = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		const firstEntryId = entries.find((entry) => entry.afterHash === first.newHash)?.id as string;
		// A later, unrelated change lands on top.
		await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: first.newHash, content: "someone else's change" });

		await expect(service.dispatch("workspace.revertMutation", { workspaceId: "ws", entryId: firstEntryId })).rejects.toBeInstanceOf(MutationRevertStale);
		await expect(service.dispatch("workspace.rawRead", { workspaceId: "ws", path: "a.txt" })).resolves.toMatchObject({ content: "someone else's change" });
	});

	it("rejects reverting an id that was never recorded", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));
		await expect(service.dispatch("workspace.revertMutation", { workspaceId: "ws", entryId: "never-recorded" })).rejects.toBeInstanceOf(MutationEntryNotFound);
	});

	it("keeps two files' histories independent", async () => {
		service = createLectorService(new Map([["ws", new InMemoryWorkspace()]]));
		await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "a.txt", expectedHash: null, content: "a" });
		await service.dispatch("workspace.exactEdit", { workspaceId: "ws", path: "b.txt", expectedHash: null, content: "b" });

		const { entries } = await service.dispatch("workspace.mutationHistory", { workspaceId: "ws", path: "a.txt", maxResults: 10 });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.path).toBe("a.txt");
	});
});
