/**
 * Walking-skeleton step 1 (lector-generic-capability-design-kkje): the core
 * performs a raw read and an exact edit against an in-memory workspace, with
 * no service, transport, or persistence involved yet.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { contentHashOf } from "../src/domain/content-hash.ts";
import { exactEdit, StaleExpectedHash } from "../src/domain/exact-edit.ts";
import { rawRead, WorkspaceEntryNotFound } from "../src/domain/raw-read.ts";

describe("rawRead", () => {
	it("returns content and its hash for an existing entry", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });

		const read = await rawRead(workspace, "a.txt");

		expect(read).toEqual({ path: "a.txt", content: "hello", hash: contentHashOf("hello") });
	});

	it("rejects a path the workspace does not have", async () => {
		const workspace = new InMemoryWorkspace();
		await expect(rawRead(workspace, "missing.txt")).rejects.toBeInstanceOf(WorkspaceEntryNotFound);
	});
});

describe("exactEdit", () => {
	it("creates a new entry when expectedHash is null and none exists", async () => {
		const workspace = new InMemoryWorkspace();

		const outcome = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });

		expect(outcome).toEqual({ path: "a.txt", previousHash: null, newHash: contentHashOf("hello") });
	});

	it("commits when expectedHash matches the current content", async () => {
		const workspace = new InMemoryWorkspace();
		const created = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });

		const outcome = await exactEdit(workspace, {
			path: "a.txt",
			expectedHash: created.newHash,
			content: "hello, world",
		});

		expect(outcome).toEqual({
			path: "a.txt",
			previousHash: contentHashOf("hello"),
			newHash: contentHashOf("hello, world"),
		});
		await expect(rawRead(workspace, "a.txt")).resolves.toMatchObject({ content: "hello, world" });
	});

	it("rejects a stale expectedHash instead of silently overwriting", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
		// Someone else committed a change we never observed.
		await exactEdit(workspace, {
			path: "a.txt",
			expectedHash: contentHashOf("hello"),
			content: "changed underneath you",
		});

		const stale = exactEdit(workspace, {
			path: "a.txt",
			expectedHash: contentHashOf("hello"), // the value we originally read, now stale
			content: "my own change",
		});

		await expect(stale).rejects.toBeInstanceOf(StaleExpectedHash);
		await expect(rawRead(workspace, "a.txt")).resolves.toMatchObject({ content: "changed underneath you" });
	});

	it("rejects a create (expectedHash: null) when the entry already exists", async () => {
		const workspace = new InMemoryWorkspace();
		await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });

		const recreate = exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "overwrite" });

		await expect(recreate).rejects.toBeInstanceOf(StaleExpectedHash);
	});
});
