/**
 * Checklist (task 3aaf70ae): atomic-write permission preservation and
 * failure surfacing, derived from doc 0ed166de-3b18-4aab-ae43-84b0efacff37
 * §6 -- CodeGraph's sedi() bug (#2097): `mv` silently adopted a temp file's
 * restrictive mode instead of the target's own permissions, and a failed
 * move was never checked, so it reported success while the edit never
 * landed. Also covers path-traversal safety, a natural requirement for any
 * real filesystem adapter (not itself one of the researched bugs, but the
 * same class GitNexus's sanitizeRepoName guards against).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFilesystemWorkspace, PathEscapesWorkspaceRoot } from "../src/adapters/local-filesystem-workspace.ts";
import { contentHashOf } from "../src/domain/content-hash.ts";
import { exactEdit } from "../src/domain/exact-edit.ts";
import { rawRead } from "../src/domain/raw-read.ts";

let root: string | undefined;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function freshRoot(): Promise<string> {
	root = await mkdtemp(join(tmpdir(), "lector-fs-workspace-"));
	return root;
}

describe("LocalFilesystemWorkspace atomic writes", () => {
	it("preserves an existing file's permission bits after an edit", async () => {
		const dir = await freshRoot();
		const workspace = new LocalFilesystemWorkspace(dir);
		const created = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "hello" });
		const absolute = join(dir, "a.txt");
		await chmod(absolute, 0o640); // deliberately non-default, distinguishable from any temp-file default

		await exactEdit(workspace, { path: "a.txt", expectedHash: created.newHash, content: "hello, world" });

		const stats = await stat(absolute);
		expect(stats.mode & 0o777).toBe(0o640);
	});

	it("gives a newly created file a sane default mode, not a temp file's restrictive mode", async () => {
		const dir = await freshRoot();
		const workspace = new LocalFilesystemWorkspace(dir);
		await exactEdit(workspace, { path: "new.txt", expectedHash: null, content: "hello" });

		const stats = await stat(join(dir, "new.txt"));
		expect(stats.mode & 0o777).toBe(0o644);
	});

	it("a failed write surfaces as a rejection, and the file's prior content is unchanged on disk", async () => {
		const dir = await freshRoot();
		const workspace = new LocalFilesystemWorkspace(dir);
		const created = await exactEdit(workspace, { path: "a.txt", expectedHash: null, content: "original" });

		// Make the directory read-only so the rename step cannot complete, simulating a failed write.
		await chmod(dir, 0o500);
		try {
			await expect(
				exactEdit(workspace, { path: "a.txt", expectedHash: created.newHash, content: "should not land" }),
			).rejects.toThrow();
		} finally {
			await chmod(dir, 0o700); // restore so afterEach's rm can clean up
		}

		const onDisk = await readFile(join(dir, "a.txt"), "utf-8");
		expect(onDisk).toBe("original");
	});

	it("rejects a path that would escape the workspace root", async () => {
		const dir = await freshRoot();
		const workspace = new LocalFilesystemWorkspace(dir);

		await expect(rawRead(workspace, "../../etc/passwd")).rejects.toBeInstanceOf(PathEscapesWorkspaceRoot);
		await expect(
			exactEdit(workspace, { path: "../outside.txt", expectedHash: null, content: "escape attempt" }),
		).rejects.toBeInstanceOf(PathEscapesWorkspaceRoot);
	});

	it(
		"accepts real, non-escaping paths when the workspace root is the filesystem root itself " +
			"(regression: root + sep string concatenation produced '//', which no real absolute " +
			"path starts with, rejecting every legitimate read as a false escape)",
		async () => {
			const dir = await freshRoot();
			const workspace = new LocalFilesystemWorkspace("/");
			// A relative path expressed from "/" down to a real tmp file this test owns.
			const relativeFromFilesystemRoot = dir.replace(/^\//, "") + "/a.txt";

			await exactEdit(workspace, { path: relativeFromFilesystemRoot, expectedHash: null, content: "hello from root" });
			const read = await rawRead(workspace, relativeFromFilesystemRoot);

			expect(read.content).toBe("hello from root");
		},
	);

	it("round-trips content and hash exactly like the in-memory adapter", async () => {
		const dir = await freshRoot();
		const workspace = new LocalFilesystemWorkspace(dir);
		await exactEdit(workspace, { path: "nested/dir/a.txt", expectedHash: null, content: "hello" });

		const read = await rawRead(workspace, "nested/dir/a.txt");
		expect(read).toEqual({ path: "nested/dir/a.txt", content: "hello", hash: contentHashOf("hello") });
	});
});
