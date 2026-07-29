/**
 * Shared conformance suite for any WorkspacePort implementation. Every
 * adapter (InMemoryWorkspace, the local-filesystem adapter, and any future
 * one) must pass this unmodified.
 */
import { describe, expect, it } from "bun:test";
import { contentHashOf } from "../../src/domain/content-hash.ts";
import { exactEdit, StaleExpectedHash } from "../../src/domain/exact-edit.ts";
import { rawRead, WorkspaceEntryNotFound } from "../../src/domain/raw-read.ts";
import type { WorkspacePort } from "../../src/ports/workspace-port.ts";

export interface ConformanceHarness {
	/** Fresh, empty workspace instance for one test. */
	createWorkspace(): WorkspacePort | Promise<WorkspacePort>;
	/** Optional per-test teardown (e.g. removing a tmp directory). */
	cleanup?(workspace: WorkspacePort): void | Promise<void>;
}

export function runWorkspacePortConformanceSuite(name: string, harness: ConformanceHarness): void {
	async function withWorkspace<T>(fn: (workspace: WorkspacePort) => Promise<T>): Promise<T> {
		const workspace = await harness.createWorkspace();
		try {
			return await fn(workspace);
		} finally {
			await harness.cleanup?.(workspace);
		}
	}

	describe(`WorkspacePort conformance: ${name}`, () => {
		describe("resolvePath", () => {
			it("is idempotent -- resolving an already-resolved path returns the same identity", () =>
				withWorkspace(async (workspace) => {
					const once = workspace.resolvePath("a.txt");
					expect(workspace.resolvePath(once)).toBe(once);
				}));

			it("resolves to an identity that reads/writes agree with", () =>
				withWorkspace(async (workspace) => {
					const resolved = workspace.resolvePath("a.txt");
					await exactEdit(workspace, { path: resolved, expectedHash: null, content: "hello" });
					await expect(rawRead(workspace, resolved)).resolves.toMatchObject({ content: "hello" });
				}));
		});

		describe("rawRead", () => {
			it("returns content and its hash for an existing entry", () =>
				withWorkspace(async (workspace) => {
					await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
					const read = await rawRead(workspace, "a.txt");
					expect(read).toEqual({ path: "a.txt", content: "hello", hash: contentHashOf("hello") });
				}));

			it("rejects a path the workspace does not have", () =>
				withWorkspace(async (workspace) => {
					await expect(rawRead(workspace, "missing.txt")).rejects.toBeInstanceOf(WorkspaceEntryNotFound);
				}));
		});

		describe("exactEdit", () => {
			it("creates a new entry when expectedHash is null and none exists", () =>
				withWorkspace(async (workspace) => {
					const outcome = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
					expect(outcome).toEqual({ path: "a.txt", previousHash: null, newHash: contentHashOf("hello") });
				}));

			it("commits when expectedHash matches the current content", () =>
				withWorkspace(async (workspace) => {
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
				}));

			it("rejects a stale expectedHash instead of silently overwriting", () =>
				withWorkspace(async (workspace) => {
					await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
					await exactEdit(workspace, {
						path: "a.txt",
						expectedHash: contentHashOf("hello"),
						content: "changed underneath you",
					});

					const stale = exactEdit(workspace, {
						path: "a.txt",
						expectedHash: contentHashOf("hello"),
						content: "my own change",
					});

					await expect(stale).rejects.toBeInstanceOf(StaleExpectedHash);
					await expect(rawRead(workspace, "a.txt")).resolves.toMatchObject({ content: "changed underneath you" });
				}));

			it("rejects a create (expectedHash: null) when the entry already exists", () =>
				withWorkspace(async (workspace) => {
					await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
					const recreate = exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "overwrite" });
					await expect(recreate).rejects.toBeInstanceOf(StaleExpectedHash);
				}));
		});

		describe("deleteEntry", () => {
			it("removes an existing entry when expectedHash matches", () =>
				withWorkspace(async (workspace) => {
					const created = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });

					const outcome = await workspace.deleteEntry("a.txt", created.newHash);

					expect(outcome).toEqual({ previousHash: created.newHash });
					await expect(rawRead(workspace, "a.txt")).rejects.toBeInstanceOf(WorkspaceEntryNotFound);
				}));

			it("rejects a stale expectedHash instead of silently deleting", () =>
				withWorkspace(async (workspace) => {
					const created = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
					await exactEdit(workspace, { path: "a.txt", expectedHash: created.newHash, content: "changed underneath you" });

					const stale = workspace.deleteEntry("a.txt", created.newHash);

					await expect(stale).rejects.toBeInstanceOf(StaleExpectedHash);
					await expect(rawRead(workspace, "a.txt")).resolves.toMatchObject({ content: "changed underneath you" });
				}));

			it("rejects deleting an entry that was never created, instead of silently no-op'ing", () =>
				withWorkspace(async (workspace) => {
					const missing = workspace.deleteEntry("never-existed.txt", contentHashOf("anything"));
					await expect(missing).rejects.toBeInstanceOf(StaleExpectedHash);
				}));
		});
	});
}
