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

interface PendingPathClassification {
	trailingCheckRequested: boolean;
}

/**
 * Serializes asynchronous existence checks per path. While one check is running, any duplicate
 * raw-event burst is represented by one boolean and therefore costs at most one trailing check --
 * no unbounded promise chain and no concurrent callbacks racing to mutate knownPaths.
 */
export class SerializedFileChangeClassifier {
	private readonly pending = new Map<string, PendingPathClassification>();
	private readonly lifetime = new AbortController();

	constructor(
		private readonly knownPaths: Set<string>,
		private readonly onEvent: (event: FileChangeEvent) => void,
		private readonly pathExists: (relativePath: string) => Promise<boolean>,
	) {}

	enqueue(relativePath: string): void {
		if (this.isClosed()) return;
		const active = this.pending.get(relativePath);
		if (active) {
			active.trailingCheckRequested = true;
			return;
		}
		const state: PendingPathClassification = { trailingCheckRequested: false };
		this.pending.set(relativePath, state);
		void this.drain(relativePath, state);
	}

	close(): void {
		this.lifetime.abort();
		this.pending.clear();
	}

	private isClosed(): boolean {
		return this.lifetime.signal.aborted;
	}

	private async drain(relativePath: string, state: PendingPathClassification): Promise<void> {
		try {
			for (;;) {
				state.trailingCheckRequested = false;
				const existsNow = await this.pathExists(relativePath);
				// close() can clear this exact state while the awaited check yields to the event loop.
				if (this.pending.get(relativePath) !== state) return;
				this.onEvent({ path: relativePath, kind: classifyFileChange(relativePath, existsNow, this.knownPaths) });
				// enqueue() can flip this while the awaited check yields; static control-flow
				// analysis sees only the assignment above and cannot model that callback.
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				if (!state.trailingCheckRequested) break;
			}
		} finally {
			if (this.pending.get(relativePath) === state) this.pending.delete(relativePath);
		}
	}
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
 * Classification is serialized independently per path. A duplicate burst while one `stat` is
 * running coalesces to one trailing existence check: created/modified can never be emitted out
 * of order by racing promises, while a real state change that landed during the first check is
 * still observed. This policy has no guessed timer window and holds at most one pending bit per
 * active path.
 */
export class NodeFsFileWatcher implements FileWatcherPort {
	watch(rootPath: string, onEvent: (event: FileChangeEvent) => void): { close(): void } {
		const knownPaths = listExistingPaths(rootPath);
		const classifier = new SerializedFileChangeClassifier(knownPaths, onEvent, (relativePath) =>
			stat(join(rootPath, relativePath)).then(
				() => true,
				() => false,
			),
		);
		const watcher = watch(rootPath, { recursive: true }, (_eventType, filename) => {
			// A null filename is a real, documented possibility on some platforms (e.g. certain
			// network filesystems) -- nothing actionable without a path, so it's dropped, not
			// guessed at.
			if (!filename) return;
			classifier.enqueue(filename.split("\\").join("/"));
		});
		return {
			close: () => {
				classifier.close();
				watcher.close();
			},
		};
	}
}
