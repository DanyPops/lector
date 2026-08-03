import { join, posix } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { applyExplorerDiffs, summarizeExplorerDiff } from "./apply-explorer-diffs.ts";
import type { DirectoryExplorerSession } from "./directory-explorer-operations.ts";
import type { EditorAction } from "./editor-state.ts";
import { EditorState } from "./editor-state.ts";
import type { EditorTheme } from "./editor-theme.ts";
import type { ExplorerDiff, ExplorerEntry } from "./explorer-diff.ts";
import { diffExplorerLines, formatExplorerLine, parseExplorerLine } from "./explorer-diff.ts";

export type ExplorerResult = { kind: "quit" } | { kind: "open-file"; absolutePath: string };

/** Joins a directory-relative name onto `directory` ("" means the resolved root itself). */
export function joinExplorerPath(directory: string, name: string): string {
	return directory === "" ? name : `${directory}/${name}`;
}

/** The relative parent of a directory-relative path; "" once already at the root. */
function parentExplorerPath(directory: string): string {
	const parent = posix.dirname(directory);
	return parent === "." ? "" : parent;
}

interface PendingConfirmation {
	readonly diffs: readonly ExplorerDiff[];
	readonly andQuit: boolean;
}

/**
 * An oil.nvim-style directory explorer: the listing IS the buffer (EditorState/LiveBuffer,
 * reused as-is from the file editor -- normal/insert/dd/yy/p/undo/:w all already do exactly what
 * renaming, deleting, and creating entries as text edits needs). Enter/`-` are intercepted before
 * EditorState ever sees them (it has no existing mapping for either, confirmed against its own
 * normal-mode key handling) since they're navigation, not buffer edits.
 *
 * :w never applies silently -- it always shows a confirmation summary first (oil.nvim's own
 * default, skip_confirm_for_simple_edits = false), even for a single change.
 */
export class ExplorerComponent implements Component {
	private readonly session: DirectoryExplorerSession;
	private readonly tui: TUI;
	private readonly theme: EditorTheme;
	private readonly done: (result: ExplorerResult) => void;

	private currentPath = "";
	private entries: ExplorerEntry[] = [];
	private nextId = 1;
	private state = new EditorState("");
	private scrollTop = 1;
	private statusMessage = "";
	private confirming: PendingConfirmation | undefined;

	constructor(tui: TUI, theme: EditorTheme, session: DirectoryExplorerSession, initialRelativePath: string, done: (result: ExplorerResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.session = session;
		this.done = done;
		void this.loadDirectory(initialRelativePath);
	}

	private pending: Promise<void> = Promise.resolve();

	invalidate(): void {}

	/** Fire-and-forget from the real TUI's own perspective (matching Component's void-returning contract) -- tests await settled() for deterministic assertions after triggering async work. */
	handleInput(data: string): void {
		this.pending = this.handleInputAsync(data);
	}

	/** Resolves once every async operation triggered by the most recent handleInput() call has finished -- a test-determinism hook, not part of the Component contract. */
	settled(): Promise<void> {
		return this.pending;
	}

	private async handleInputAsync(data: string): Promise<void> {
		if (this.confirming) {
			await this.handleConfirmationInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.state.mode === "normal") {
			if (data === "\r" || data === "\n") {
				await this.openCurrentLine();
				this.tui.requestRender();
				return;
			}
			if (data === "-") {
				await this.navigateToParent();
				this.tui.requestRender();
				return;
			}
		}

		this.state.handleKey(data);
		this.scrollToKeepCursorVisible();
		const action = this.state.pendingAction;
		if (action) await this.performAction(action);
		this.tui.requestRender();
	}

	private async loadDirectory(relativePath: string): Promise<void> {
		const listing = await this.session.listDirectory(relativePath);
		this.currentPath = relativePath;
		this.nextId = 1;
		this.entries = listing.entries.map((entry) => ({ id: this.nextId++, name: entry.name, kind: entry.kind }));
		const text = this.entries.length > 0 ? this.entries.map((entry) => formatExplorerLine(entry)).join("\n") : "";
		this.state = new EditorState(text);
		this.confirming = undefined;
		this.statusMessage = "";
		this.tui.requestRender();
	}

	private async openCurrentLine(): Promise<void> {
		const parsed = parseExplorerLine(this.state.currentLineText);
		if (!parsed || parsed.id === null) return; // a blank line or an unsaved new entry -- nothing real to open yet
		const entry = this.entries.find((candidate) => candidate.id === parsed.id);
		if (!entry) return;

		if (entry.kind === "directory") {
			await this.loadDirectory(joinExplorerPath(this.currentPath, entry.name));
			return;
		}
		this.done({ kind: "open-file", absolutePath: join(this.session.root, joinExplorerPath(this.currentPath, entry.name)) });
	}

	private async navigateToParent(): Promise<void> {
		if (this.currentPath === "") return; // already at the resolved root -- v1 never widens scope above it
		await this.loadDirectory(parentExplorerPath(this.currentPath));
	}

	private async performAction(action: EditorAction): Promise<void> {
		switch (action.kind) {
			case "save":
			case "save-and-quit": {
				const diffs = diffExplorerLines(this.entries, this.state.buffer.text.split("\n"));
				this.state.dirty = false;
				if (diffs.length === 0) {
					this.statusMessage = "no changes";
					if (action.kind === "save-and-quit") this.done({ kind: "quit" });
					return;
				}
				this.confirming = { diffs, andQuit: action.kind === "save-and-quit" };
				return;
			}
			case "quit":
				this.done({ kind: "quit" });
				return;
			case "hover":
				this.statusMessage = "hover is not applicable in the file explorer";
				return;
			default: {
				const exhaustive: never = action;
				throw new Error(`Unhandled editor action: ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	private async handleConfirmationInput(data: string): Promise<void> {
		if (!this.confirming) return;
		if (data === "n" || data === "\x1b") {
			this.confirming = undefined;
			this.statusMessage = "cancelled";
			return;
		}
		if (data !== "y" && data !== "\r" && data !== "\n") return;

		const { diffs, andQuit } = this.confirming;
		try {
			await applyExplorerDiffs(this.session, this.currentPath, diffs);
		} catch (error) {
			this.confirming = undefined;
			this.statusMessage = `apply failed: ${error instanceof Error ? error.message : String(error)}`;
			return;
		}
		if (andQuit) {
			this.done({ kind: "quit" });
			return;
		}
		await this.loadDirectory(this.currentPath);
		this.statusMessage = "applied";
	}

	private scrollToKeepCursorVisible(): void {
		const viewportHeight = Math.max(1, this.tui.terminal.rows - 2);
		if (this.state.cursorLine < this.scrollTop) this.scrollTop = this.state.cursorLine;
		else if (this.state.cursorLine >= this.scrollTop + viewportHeight) this.scrollTop = this.state.cursorLine - viewportHeight + 1;
	}

	render(width: number): string[] {
		if (this.confirming) return this.renderConfirmation(this.confirming, width);

		const viewportHeight = Math.max(1, this.tui.terminal.rows - 2);
		const lastLine = Math.min(this.state.buffer.lineCount, this.scrollTop + viewportHeight - 1);

		const lines: string[] = [];
		for (let line = this.scrollTop; line <= lastLine; line++) lines.push(this.renderLine(line, width));
		while (lines.length < viewportHeight) lines.push("");

		lines.push(this.renderStatusLine(width));
		return lines;
	}

	private renderConfirmation(confirming: PendingConfirmation, width: number): string[] {
		const lines = ["Pending changes:", "", ...confirming.diffs.map((diff) => `  ${summarizeExplorerDiff(diff)}`), "", "Apply? (y/n)"];
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderLine(line: number, width: number): string {
		const lineText = this.state.buffer.lineText(line);
		const isCursorLine = line === this.state.cursorLine;
		const styled = isCursorLine ? this.renderLineWithCursor(lineText) : this.renderStyledLine(lineText);
		return truncateToWidth(styled, width, "");
	}

	/** Dims the id prefix (a real character sequence in this terminal, not truly hidden -- see explorer-diff.ts) so it reads as secondary to the entry's own name. */
	private renderStyledLine(lineText: string): string {
		const match = lineText.match(/^(\d+ )(.*)$/);
		if (!match) return lineText;
		const [, idPart, rest] = match;
		return `${this.theme.fg("muted", idPart ?? "")}${rest ?? ""}`;
	}

	private renderLineWithCursor(lineText: string): string {
		const col = this.state.cursorCharacter - 1;
		const before = this.renderStyledLine(lineText.slice(0, col));
		const atCursor = col < lineText.length ? lineText[col] : " ";
		const after = lineText.slice(col + 1);
		return `${before}\x1b[7m${atCursor}\x1b[0m${after}`;
	}

	private renderStatusLine(width: number): string {
		const modeLabel = { normal: " NORMAL ", insert: " INSERT ", command: " COMMAND " }[this.state.mode];
		const location = this.currentPath === "" ? "/" : `/${this.currentPath}/`;
		const left = this.state.mode === "command" ? `:${this.state.commandText}` : `${this.theme.fg("accent", modeLabel)} ${location}`;
		const right = this.statusMessage || `${this.state.cursorLine}:${this.state.cursorCharacter}`;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
	}
}
