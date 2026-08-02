import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileChangeEvent } from "./file-change-event.ts";
import type { FileWatcherPort } from "./port.ts";

/**
 * FileWatcherPort backed by Node/Bun's own `fs.watch(root, {recursive: true})` -- confirmed
 * directly against this project's own real environment (Bun on Linux), not assumed from docs
 * alone, since Node's recursive-watch support has historically been platform-inconsistent.
 *
 * `fs.watch`'s own event shape only ever reports "rename" (covering both create AND delete --
 * a real, documented Node limitation, not something this adapter can see past) or "change"
 * (a content modification). A "rename" event is disambiguated by checking whether the path
 * exists immediately afterward: present means created (or renamed-in-place, indistinguishable
 * without more information than fs.watch provides at all), absent means deleted.
 *
 * Deliberately no debouncing: a single logical save that an editor performs via a temp-file
 * write + atomic rename can surface as more than one raw event for the same path in quick
 * succession. Coalescing would require inventing a time-window policy with no real evidence
 * yet for what it should be -- left as a known, honest limitation rather than a guessed one.
 */
export class NodeFsFileWatcher implements FileWatcherPort {
	watch(rootPath: string, onEvent: (event: FileChangeEvent) => void): { close(): void } {
		const watcher = watch(rootPath, { recursive: true }, (eventType, filename) => {
			// A null filename is a real, documented possibility on some platforms (e.g. certain
			// network filesystems) -- nothing actionable without a path, so it's dropped, not
			// guessed at.
			if (!filename) return;
			const relativePath = filename.split("\\").join("/");
			if (eventType === "change") {
				onEvent({ path: relativePath, kind: "modified" });
				return;
			}
			stat(join(rootPath, filename)).then(
				() => onEvent({ path: relativePath, kind: "created" }),
				() => onEvent({ path: relativePath, kind: "deleted" }),
			);
		});
		return { close: () => watcher.close() };
	}
}
