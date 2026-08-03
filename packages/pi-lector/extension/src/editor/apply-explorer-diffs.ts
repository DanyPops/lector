import type { DirectoryExplorerSession } from "./directory-explorer-operations.ts";
import type { ExplorerDiff } from "./explorer-diff.ts";

function joinRelative(directory: string, name: string): string {
	return directory === "" ? name : `${directory}/${name}`;
}

/** Applies a diff batch to `directory`, in order. Never partial-rolls-back a failure partway through -- the caller (the explorer's own :w confirmation flow) is responsible for surfacing which operations landed before an error, via each real thrown error's own message. */
export async function applyExplorerDiffs(session: DirectoryExplorerSession, directory: string, diffs: readonly ExplorerDiff[]): Promise<void> {
	for (const diff of diffs) {
		switch (diff.kind) {
			case "create":
				if (diff.isDirectory) await session.createDirectory(joinRelative(directory, diff.name));
				else await session.createFile(joinRelative(directory, diff.name));
				break;
			case "rename":
				await session.renamePath(joinRelative(directory, diff.fromName), joinRelative(directory, diff.toName));
				break;
			case "delete":
				if (diff.isDirectory) await session.deleteDirectory(joinRelative(directory, diff.name));
				else await session.deleteFile(joinRelative(directory, diff.name));
				break;
			default: {
				const exhaustive: never = diff;
				throw new Error(`unreachable explorer diff kind: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
}

/** One human-readable confirmation line for a pending diff, shown before :w actually applies anything. */
export function summarizeExplorerDiff(diff: ExplorerDiff): string {
	switch (diff.kind) {
		case "create":
			return `+ ${diff.name}${diff.isDirectory ? "/" : ""}`;
		case "rename":
			return `${diff.fromName} -> ${diff.toName}`;
		case "delete":
			return `- ${diff.name}${diff.isDirectory ? "/" : ""}`;
		default: {
			const exhaustive: never = diff;
			throw new Error(`unreachable explorer diff kind: ${JSON.stringify(exhaustive)}`);
		}
	}
}
