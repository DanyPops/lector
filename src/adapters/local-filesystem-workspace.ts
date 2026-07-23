import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { contentHashOf, type ContentHash } from "../domain/content-hash.ts";
import { StaleExpectedHash } from "../domain/exact-edit.ts";
import type { WorkspaceEntry, WorkspacePort } from "../ports/workspace-port.ts";

const DEFAULT_NEW_FILE_MODE = 0o644;
const PERMISSION_BITS_MASK = 0o777;

/** Raised when a path would resolve outside the workspace's own root directory. */
export class PathEscapesWorkspaceRoot extends Error {
	constructor(
		readonly path: string,
		readonly root: string,
	) {
		super(`path "${path}" escapes workspace root "${root}"`);
		this.name = "PathEscapesWorkspaceRoot";
	}
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * LocalFilesystemWorkspace -- a WorkspacePort backed by real files under one
 * root directory. Walking-skeleton step 3
 * (lector-generic-capability-design-kkje): "local filesystem adapter with
 * expected-hash atomic writes."
 *
 * Writes are atomic (write to a same-directory temp file, then rename over
 * the target) and preserve the target's existing permission bits rather than
 * adopting the temp file's default mode -- CodeGraph's sedi() bug (#2097):
 * `mv` replaces the target's inode, silently inheriting mktemp's restrictive
 * 0600 instead of the file's own permissions, and never checked whether the
 * move actually succeeded. Both are fixed here: the temp file's mode is
 * corrected *before* the rename (so the file at its final path never has a
 * window with the wrong permissions), and any failure at any step propagates
 * as a rejection rather than a silently-successful no-op.
 */
export class LocalFilesystemWorkspace implements WorkspacePort {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	private resolvePath(path: string): string {
		const absolute = resolve(this.root, path);
		if (absolute !== this.root && !absolute.startsWith(this.root + sep)) {
			throw new PathEscapesWorkspaceRoot(path, this.root);
		}
		return absolute;
	}

	async readEntry(path: string): Promise<WorkspaceEntry> {
		const absolute = this.resolvePath(path);
		try {
			const content = await readFile(absolute, "utf-8");
			return { exists: true, content };
		} catch (error) {
			if (isEnoent(error)) return { exists: false };
			throw error;
		}
	}

	async writeEntry(
		path: string,
		expectedHash: ContentHash | null,
		content: string,
	): Promise<{ previousHash: ContentHash | null; newHash: ContentHash }> {
		const absolute = this.resolvePath(path);

		let previousHash: ContentHash | null = null;
		let previousMode: number | undefined;
		try {
			const [existingContent, stats] = await Promise.all([readFile(absolute, "utf-8"), stat(absolute)]);
			previousHash = contentHashOf(existingContent);
			previousMode = stats.mode & PERMISSION_BITS_MASK;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		if (previousHash !== expectedHash) {
			throw new StaleExpectedHash(path, expectedHash, previousHash);
		}

		await mkdir(dirname(absolute), { recursive: true });
		const tempPath = join(dirname(absolute), `.lector-${randomBytes(8).toString("hex")}.tmp`);
		try {
			await writeFile(tempPath, content, "utf-8");
			await chmod(tempPath, previousMode ?? DEFAULT_NEW_FILE_MODE);
			await rename(tempPath, absolute);
		} catch (error) {
			await rm(tempPath, { force: true });
			throw error;
		}

		return { previousHash, newHash: contentHashOf(content) };
	}
}
