import { type ContentHash, contentHashOf } from "../domain/content-hash.ts";
import { StaleExpectedHash } from "../domain/exact-edit.ts";
import type { WorkspaceEntry, WorkspacePort } from "../ports/workspace-port.ts";

/**
 * InMemoryWorkspace — a WorkspacePort backed by a plain Map, for the walking
 * skeleton and for shared conformance fixtures. Holds no file descriptors,
 * watches nothing, and is discarded with the process; a local-filesystem
 * adapter implements the same port for real workspaces.
 */
export class InMemoryWorkspace implements WorkspacePort {
	private readonly entries = new Map<string, string>();

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
}
