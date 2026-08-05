import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { StaleExpectedHash } from "./exact-edit.ts";
import { type FileTreeEntry, type FileTreePort, WorkspaceEntryAlreadyExists, WorkspaceEntryDoesNotExist } from "./file-tree-port.ts";
import type { WorkspaceEntry, WorkspacePort } from "./port.ts";

function normalizeDirectoryPath(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function nameOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

/** Every ancestor directory of `path`, root-first (e.g. "a/b/c" -> ["a", "a/b", "a/b/c"]). */
function ancestorsInclusive(path: string): string[] {
	const segments = normalizeDirectoryPath(path)
		.split("/")
		.filter((segment) => segment.length > 0);
	const result: string[] = [];
	let current = "";
	for (const segment of segments) {
		current = current === "" ? segment : `${current}/${segment}`;
		result.push(current);
	}
	return result;
}

/**
 * InMemoryWorkspace — a WorkspacePort backed by a plain Map, for the walking
 * skeleton and for shared conformance fixtures. Holds no file descriptors,
 * watches nothing, and is discarded with the process; a local-filesystem
 * adapter implements the same port for real workspaces.
 *
 * Also implements FileTreePort: a flat content map alone cannot represent an empty directory, so
 * directories are tracked explicitly (both ones created directly via createDirectory and every
 * ancestor implied by a file's own path) rather than inferred purely from file key prefixes.
 */
export class InMemoryWorkspace implements WorkspacePort, FileTreePort {
	private readonly entries = new Map<string, string>();
	private readonly directories = new Set<string>();

	/** No real filesystem root to resolve against -- whatever string a caller uses is already this workspace's own identity for it. */
	resolvePath(path: string): string {
		return path;
	}

	async readEntry(path: string): Promise<WorkspaceEntry> {
		const content = this.entries.get(path);
		return content === undefined ? { exists: false } : { exists: true, content };
	}

	async writeEntry(path: string, expectedHash: ContentHash | null, content: string): Promise<{ previousHash: ContentHash | null; newHash: ContentHash }> {
		const existing = this.entries.get(path);
		const previousHash = existing === undefined ? null : contentHashOf(existing);
		if (previousHash !== expectedHash) {
			throw new StaleExpectedHash(path, expectedHash, previousHash);
		}
		this.entries.set(path, content);
		for (const ancestor of ancestorsInclusive(parentOf(normalizeDirectoryPath(path)))) this.directories.add(ancestor);
		return { previousHash, newHash: contentHashOf(content) };
	}

	async deleteEntry(path: string, expectedHash: ContentHash): Promise<{ previousHash: ContentHash }> {
		const existing = this.entries.get(path);
		const previousHash = existing === undefined ? null : contentHashOf(existing);
		if (previousHash !== expectedHash) {
			throw new StaleExpectedHash(path, expectedHash, previousHash);
		}
		this.entries.delete(path);
		return { previousHash };
	}

	async listDirectory(path: string): Promise<FileTreeEntry[]> {
		const normalized = normalizeDirectoryPath(path);
		const seen = new Map<string, FileTreeEntry>();
		for (const filePath of this.entries.keys()) {
			if (parentOf(filePath) === normalized) seen.set(nameOf(filePath), { name: nameOf(filePath), kind: "file" });
		}
		for (const directoryPath of this.directories) {
			if (parentOf(directoryPath) === normalized) seen.set(nameOf(directoryPath), { name: nameOf(directoryPath), kind: "directory" });
		}
		return [...seen.values()];
	}

	async createDirectory(path: string): Promise<void> {
		for (const ancestor of ancestorsInclusive(path)) this.directories.add(ancestor);
	}

	async renamePath(oldPath: string, newPath: string): Promise<void> {
		const normalizedOld = normalizeDirectoryPath(oldPath);
		const normalizedNew = normalizeDirectoryPath(newPath);
		const isFile = this.entries.has(normalizedOld);
		const isDirectory = this.directories.has(normalizedOld);
		if (!isFile && !isDirectory) throw new WorkspaceEntryDoesNotExist(oldPath);
		if (this.entries.has(normalizedNew) || this.directories.has(normalizedNew)) throw new WorkspaceEntryAlreadyExists(newPath);

		if (isFile) {
			const content = this.entries.get(normalizedOld);
			if (content !== undefined) {
				this.entries.delete(normalizedOld);
				this.entries.set(normalizedNew, content);
			}
		}
		if (isDirectory) {
			const prefix = `${normalizedOld}/`;
			for (const directoryPath of [...this.directories]) {
				if (directoryPath === normalizedOld) {
					this.directories.delete(directoryPath);
					this.directories.add(normalizedNew);
				} else if (directoryPath.startsWith(prefix)) {
					this.directories.delete(directoryPath);
					this.directories.add(normalizedNew + directoryPath.slice(normalizedOld.length));
				}
			}
			for (const filePath of [...this.entries.keys()]) {
				if (filePath.startsWith(prefix)) {
					const content = this.entries.get(filePath);
					this.entries.delete(filePath);
					if (content !== undefined) this.entries.set(normalizedNew + filePath.slice(normalizedOld.length), content);
				}
			}
		}
		for (const ancestor of ancestorsInclusive(parentOf(normalizedNew))) this.directories.add(ancestor);
	}

	async deleteDirectory(path: string): Promise<void> {
		const normalized = normalizeDirectoryPath(path);
		const prefix = `${normalized}/`;
		this.directories.delete(normalized);
		for (const directoryPath of [...this.directories]) if (directoryPath.startsWith(prefix)) this.directories.delete(directoryPath);
		for (const filePath of [...this.entries.keys()]) if (filePath.startsWith(prefix)) this.entries.delete(filePath);
	}
}
