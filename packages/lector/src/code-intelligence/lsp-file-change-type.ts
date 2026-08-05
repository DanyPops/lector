import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";

/** LSP's FileChangeType enum: Created = 1, Changed = 2, Deleted = 3. */
export type LspFileChangeType = 1 | 2 | 3;

const MAPPING: Readonly<Record<FileChangeEvent["kind"], LspFileChangeType>> = {
	created: 1,
	modified: 2,
	deleted: 3,
};

export function toLspFileChangeType(kind: FileChangeEvent["kind"]): LspFileChangeType {
	return MAPPING[kind];
}
