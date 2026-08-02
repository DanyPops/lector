import type { FileChangeEvent } from "./file-change-event.ts";

/**
 * FileWatcherPort -- the role a driven adapter plays for observing real filesystem changes
 * under one workspace root, recursively. Deliberately one watcher per root, not one per
 * caller-registered pattern: many registered patterns for the same workspace share the same
 * underlying OS watch (see the service layer's own registry), which is what this port itself
 * is scoped to provide -- raw change events, unfiltered by any pattern.
 */
export interface FileWatcherPort {
	/** Starts watching rootPath recursively; onEvent fires for every real change until close() is called. Throws if the platform/OS refuses to watch (e.g. inotify limit exhausted) -- fails closed, never silently drops future events instead. */
	watch(rootPath: string, onEvent: (event: FileChangeEvent) => void): { close(): void };
}
