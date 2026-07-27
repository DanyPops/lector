import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ContentHash, contentHashOf } from "../domain/content-hash.ts";
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
 * root directory, with expected-hash-guarded atomic writes.
 *
 * Writes go through a same-directory temp file, chmod'd to the target's
 * existing mode before the rename (temp files default to a more
 * restrictive mode, which a naive rename would otherwise leave in place).
 */
export class LocalFilesystemWorkspace implements WorkspacePort {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	resolvePath(path: string): string {
		const absolute = resolve(this.root, path);
		// node:path's relative(), not string-prefix concatenation: `this.root + sep` breaks for
		// the filesystem root itself ("/" + "/" = "//", which no real absolute path starts
		// with -- root="/" is a real, legitimate case: a path with no enclosing project root
		// falls back to it, per pi-lector's workspaceForPath, and every such read was rejected
		// as "escaping" a root it did not actually escape at all).
		const relativeToRoot = relative(this.root, absolute);
		if (relativeToRoot === ".." || relativeToRoot.startsWith(".." + sep) || isAbsolute(relativeToRoot)) {
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

	async writeEntry(path: string, expectedHash: ContentHash | null, content: string): Promise<{ previousHash: ContentHash | null; newHash: ContentHash }> {
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
