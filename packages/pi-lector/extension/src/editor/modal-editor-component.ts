import { extname } from "node:path";
import type { HighlightSpan } from "@danypops/lector";
import { highlightSpans } from "@danypops/lector";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorAction } from "./editor-state.ts";
import { EditorState } from "./editor-state.ts";
import type { EditorTheme } from "./editor-theme.ts";

export type { EditorTheme } from "./editor-theme.ts";

export interface ModalEditorHost {
	filePath: string;
	/** Saves the buffer's current text through Lector's hash-guarded write. Throws (surfaced as a status message, not a crash) on a genuinely concurrent external change. */
	save(text: string): Promise<void>;
	/** Real hover info from Lector's existing code-intelligence operation, or undefined when there is none at this position. */
	hover(line: number, character: number): Promise<{ contents: string } | undefined>;
}

const CAPTURE_COLOR: Record<string, ThemeColor> = {
	keyword: "syntaxKeyword",
	comment: "syntaxComment",
	string: "syntaxString",
	number: "syntaxNumber",
	function: "syntaxFunction",
	type: "syntaxType",
};

/**
 * A real, full-file, modal code editor Component -- not a CustomEditor subclass
 * (that API replaces Pi's own chat input, not a full-file view; confirmed against
 * docs/tui.md's Pattern 7 and examples/extensions/modal-editor.ts). Renders as a `ctx.ui.custom`
 * overlay. Owns no authoritative state of its own past the open edit session: `EditorState`'s
 * LiveBuffer is the only in-memory copy, and every save round-trips through the host's
 * hash-guarded write -- never a second source of truth for the file's real disk content.
 */
export class ModalEditorComponent implements Component {
	private readonly state: EditorState;
	private readonly host: ModalEditorHost;
	private readonly tui: TUI;
	private readonly theme: EditorTheme;
	private readonly done: () => void;
	private readonly extension: string;

	private scrollTop = 1;
	private statusMessage = "";
	private highlightCache: { text: string; spans: readonly HighlightSpan[] } | undefined;

	constructor(tui: TUI, theme: EditorTheme, host: ModalEditorHost, content: string, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.host = host;
		this.done = done;
		this.extension = extname(host.filePath);
		this.state = new EditorState(content);
		this.refreshHighlightsSafely();
	}

	invalidate(): void {
		this.highlightCache = undefined;
	}

	/**
	 * Fire-and-forget from the real TUI's own perspective (matching Component's void-returning
	 * contract). Any rejection from performAction (host.save/host.hover talking to a daemon that
	 * fails or restarts mid-session) is caught here rather than left to become an unhandled
	 * rejection that crashes the whole Pi process -- the same defect class found and fixed in
	 * ExplorerComponent's own constructor.
	 */
	handleInput(data: string): void {
		this.state.handleKey(data);
		this.scrollToKeepCursorVisible();
		const action = this.state.pendingAction;
		if (action) this.performActionSafely(action);
		this.tui.requestRender();
	}

	private performActionSafely(action: EditorAction): void {
		void this.performAction(action).catch((error: unknown) => {
			this.statusMessage = `error: ${error instanceof Error ? error.message : String(error)}`;
			this.tui.requestRender();
		});
	}

	/** Highlighting is cosmetic: a failure here must never surface as a status message that stomps a real save/hover result, and must never crash the editor. */
	private refreshHighlightsSafely(): void {
		void this.refreshHighlights().catch(() => undefined);
	}

	private async performAction(action: EditorAction): Promise<void> {
		switch (action.kind) {
			case "save":
			case "save-and-quit": {
				try {
					await this.host.save(this.state.buffer.text);
					this.state.dirty = false;
					this.statusMessage = `"${this.host.filePath}" written`;
				} catch (error) {
					this.statusMessage = `save failed: ${error instanceof Error ? error.message : String(error)}`;
					this.tui.requestRender();
					return;
				}
				if (action.kind === "save-and-quit") {
					this.done();
					return;
				}
				break;
			}
			case "quit":
				this.done();
				return;
			case "hover": {
				const hover = await this.host.hover(this.state.cursorLine, this.state.cursorCharacter);
				const firstLine = hover?.contents.split("\n")[0];
				this.statusMessage = firstLine ?? "no hover info at this position";
				break;
			}
			default: {
				const exhaustive: never = action;
				throw new Error(`Unhandled editor action: ${JSON.stringify(exhaustive)}`);
			}
		}
		this.tui.requestRender();
	}

	private async refreshHighlights(): Promise<void> {
		const text = this.state.buffer.text;
		const spans = await highlightSpans(text, this.extension);
		this.highlightCache = { text, spans };
		this.tui.requestRender();
	}

	private refreshHighlightsIfStale(): void {
		if (this.highlightCache?.text !== this.state.buffer.text) this.refreshHighlightsSafely();
	}

	private scrollToKeepCursorVisible(): void {
		const viewportHeight = Math.max(1, this.tui.terminal.rows - 2);
		if (this.state.cursorLine < this.scrollTop) this.scrollTop = this.state.cursorLine;
		else if (this.state.cursorLine >= this.scrollTop + viewportHeight) this.scrollTop = this.state.cursorLine - viewportHeight + 1;
	}

	render(width: number): string[] {
		this.refreshHighlightsIfStale();

		const viewportHeight = Math.max(1, this.tui.terminal.rows - 2);
		const gutterWidth = Math.max(3, String(this.state.buffer.lineCount).length) + 1;
		const lastLine = Math.min(this.state.buffer.lineCount, this.scrollTop + viewportHeight - 1);

		const lines: string[] = [];
		for (let line = this.scrollTop; line <= lastLine; line++) {
			lines.push(this.renderLine(line, gutterWidth, width - gutterWidth));
		}
		while (lines.length < viewportHeight) lines.push("");

		lines.push(this.renderStatusLine(width));
		return lines;
	}

	private renderLine(line: number, gutterWidth: number, contentWidth: number): string {
		const isCursorLine = line === this.state.cursorLine;
		const gutterNumber = isCursorLine ? String(line) : String(Math.abs(line - this.state.cursorLine));
		const gutter = `${this.theme.fg(isCursorLine ? "text" : "muted", gutterNumber.padStart(gutterWidth - 1))} `;

		const lineText = this.state.buffer.lineText(line);
		const rendered = isCursorLine ? this.renderLineWithCursor(line, lineText) : this.renderHighlightedLine(line, lineText);
		return gutter + truncateToWidth(rendered, contentWidth, "");
	}

	private spansForLine(line: number): readonly HighlightSpan[] {
		if (!this.highlightCache) return [];
		const from = this.state.buffer.offsetAt({ line, character: 1 });
		const to = from + this.state.buffer.lineText(line).length;
		return this.highlightCache.spans.filter((span) => span.startIndex < to && span.endIndex > from);
	}

	private renderHighlightedLine(line: number, lineText: string): string {
		const from = this.state.buffer.offsetAt({ line, character: 1 });
		const spans = this.spansForLine(line);
		let result = "";
		let cursor = 0;
		for (const span of spans) {
			const start = Math.max(span.startIndex - from, 0);
			const end = Math.min(span.endIndex - from, lineText.length);
			if (start < cursor) continue; // overlapping captures -- keep the earliest, simplest for v1
			result += lineText.slice(cursor, start);
			const color = CAPTURE_COLOR[span.capture];
			result += color ? this.theme.fg(color, lineText.slice(start, end)) : lineText.slice(start, end);
			cursor = end;
		}
		result += lineText.slice(cursor);
		return result;
	}

	/** The cursor's own line: highlighted text plus an inverse-video cursor cell, matching pi-tui's own Editor cursor convention. */
	private renderLineWithCursor(line: number, lineText: string): string {
		const highlighted = this.renderHighlightedLine(line, lineText);
		// Re-slicing a pre-highlighted (ANSI-embedded) string by character index would misplace the
		// cursor inside escape codes -- render the cursor against the plain text, forgoing this
		// line's syntax highlighting. Acceptable for v1: only one line is ever affected at a time.
		void highlighted;
		const col = this.state.cursorCharacter - 1;
		const before = lineText.slice(0, col);
		const atCursor = col < lineText.length ? lineText[col] : " ";
		const after = col < lineText.length ? lineText.slice(col + 1) : "";
		return `${before}\x1b[7m${atCursor}\x1b[0m${after}`;
	}

	private renderStatusLine(width: number): string {
		const modeLabel = { normal: " NORMAL ", insert: " INSERT ", command: " COMMAND " }[this.state.mode];
		const dirtyMarker = this.state.dirty ? " [+]" : "";
		const position = `${this.state.cursorLine}:${this.state.cursorCharacter}`;
		const left = this.state.mode === "command" ? `:${this.state.commandText}` : `${this.theme.fg("accent", modeLabel)} ${this.host.filePath}${dirtyMarker}`;
		const right = this.statusMessage || position;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
	}
}
