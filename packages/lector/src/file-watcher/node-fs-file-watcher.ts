import { type Dirent, readdirSync, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileChangeEvent } from "./file-change-event.ts";
import type { FileWatcherPort } from "./port.ts";

/**
 * A real, synchronous recursive listing of every entry (files and directories alike) already
 * present under rootPath at watch-start time, as workspace-relative POSIX paths. Seeds the
 * create/modify disambiguation below with what already existed before this watch began, so a
 * change to a pre-existing file is never mistaken for its creation.
 */
function listExistingPaths(rootPath: string): Set<string> {
	const known = new Set<string>();
	const walk = (dir: string, relativeDir: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			known.add(relativePath);
			if (entry.isDirectory()) walk(join(dir, entry.name), relativePath);
		}
	};
	walk(rootPath, "");
	return known;
}

/**
 * Classifies one real filesystem change purely from its current existence and prior membership
 * in `knownPaths`, mutating `knownPaths` to reflect the new state -- deliberately independent of
 * whatever raw event type ("rename" vs "change") the underlying platform's `fs.watch` reported,
 * since that label has been observed to disagree with reality across platforms (a brand-new file
 * surfacing as a plain "change" rather than "rename" on at least one real CI runner).
 */
export function classifyFileChange(relativePath: string, existsNow: boolean, knownPaths: Set<string>): FileChangeEvent["kind"] {
	if (!existsNow) {
		knownPaths.delete(relativePath);
		return "deleted";
	}
	const kind = knownPaths.has(relativePath) ? "modified" : "created";
	knownPaths.add(relativePath);
	return kind;
}

/**
 * FileWatcherPort backed by Node/Bun's own `fs.watch(root, {recursive: true})` -- confirmed
 * directly against this project's own real environment (Bun on Linux), not assumed from docs
 * alone, since Node's recursive-watch support has historically been platform-inconsistent.
 *
 * `fs.watch`'s own raw event *type* ("rename" vs "change") is a real, documented Node
 * limitation on which platforms can't be trusted to agree: some report a brand-new file as
 * "rename" (the create/delete-conflating type), others as a plain "change". Rather than branch
 * on that raw label at all, every event is classified purely by comparing the path's real
 * existence (a `stat` immediately afterward) against a `knownPaths` set this adapter maintains
 * itself, seeded from a real directory listing at watch-start: present-and-previously-known
 * means modified, present-and-new means created, absent means deleted. This is robust to
 * whichever raw event type any given platform happens to emit for a given operation.
 *
 * Deliberately no debouncing: a single logical save that an editor performs via a temp-file
 * write + atomic rename can surface as more than one raw event for the same path in quick
 * succession. Coalescing would require inventing a time-window policy with no real evidence
 * yet for what it should be -- left as a known, honest limitation rather than a guessed one.
 */
export class NodeFsFileWatcher implements FileWatcherPort {
	watch(rootPath: string, onEvent: (event: FileChangeEvent) => void): { close(): void } {
		const knownPaths = listExistingPaths(rootPath);
		const watcher = watch(rootPath, { recursive: true }, (_eventType, filename) => {
			// A null filename is a real, documented possibility on some platforms (e.g. certain
			// network filesystems) -- nothing actionable without a path, so it's dropped, not
			// guessed at.
			if (!filename) return;
			const relativePath = filename.split("\\").join("/");
			stat(join(rootPath, filename)).then(
				() => onEvent({ path: relativePath, kind: classifyFileChange(relativePath, true, knownPaths) }),
				() => onEvent({ path: relativePath, kind: classifyFileChange(relativePath, false, knownPaths) }),
			);
		});
		return { close: () => watcher.close() };
	}
}
