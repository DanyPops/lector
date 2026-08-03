import { dirname, relative } from "node:path";
import type { DirectoryExplorerSession } from "./directory-explorer-operations.ts";
import type { ExplorerResult } from "./explorer-component.ts";

export interface ExplorerFlowHost {
	/** Shows the explorer at `relativePath` (root-relative, "" for the resolved root) and resolves once the user quits or opens a file. */
	showExplorer(session: DirectoryExplorerSession, relativePath: string): Promise<ExplorerResult>;
	/** Shows the real file editor for `absolutePath` and resolves once the user quits it. */
	showEditor(absolutePath: string): Promise<void>;
}

/**
 * Oil-style /editor-with-no-path loop: browse, open a file into the real editor, then return to
 * the explorer -- at the directory the opened file lives in, not the resolved root -- once that
 * editor quits, rather than closing the whole session after the first file opened.
 */
export async function runExplorerFlow(session: DirectoryExplorerSession, host: ExplorerFlowHost): Promise<void> {
	let relativePath = "";
	for (;;) {
		const result = await host.showExplorer(session, relativePath);
		if (result.kind === "quit") return;

		await host.showEditor(result.absolutePath);
		// path.relative(root, root) is "" directly, matching ExplorerComponent's own root-relative convention -- no "." case to normalize.
		relativePath = relative(session.root, dirname(result.absolutePath));
	}
}
