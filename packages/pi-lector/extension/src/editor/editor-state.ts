import { LiveBuffer } from "@danypops/lector";

export type EditorMode = "normal" | "insert" | "command";

export type EditorAction = { kind: "save" } | { kind: "save-and-quit" } | { kind: "quit" } | { kind: "hover" };

export interface EditorSourcePosition {
	/** One-based line number. */
	readonly line: number;
	/** One-based UTF-16 code-unit position within the line. */
	readonly character: number;
}

export type EditorPositionErrorCode = "line-out-of-range" | "character-out-of-range";

/** Reports why a requested source position cannot identify a cursor location in the current buffer. */
export class EditorPositionError extends Error {
	constructor(
		readonly code: EditorPositionErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "EditorPositionError";
	}
}

const BACKSPACE_KEYS = new Set(["\x7f", "\b"]);

/**
 * Pure modal editing state machine: mode transitions, cursor motion, and buffer
 * edits, with no terminal/ANSI rendering and no I/O -- save/quit/hover requests surface as
 * `pendingAction` for the hosting Component to actually perform (reading/writing through
 * Lector's hash-guarded workspace operations lives outside this class entirely). Kept
 * side-effect-free like this specifically so mode/motion/edit logic is unit-testable without a
 * real terminal, per this environment's own "test behavior, not pixels" TUI-testing standard.
 */
export class EditorState {
	buffer: LiveBuffer;
	mode: EditorMode = "normal";
	cursorLine = 1;
	cursorCharacter = 1;
	commandText = "";
	pendingAction: EditorAction | undefined;
	dirty = false;

	private normalPrefix = "";
	private insertPendingJ = false;
	private yankedLine: string | undefined;

	constructor(content: string, initialPosition?: EditorSourcePosition) {
		this.buffer = new LiveBuffer(content);
		if (initialPosition) this.moveToInitialPosition(initialPosition);
	}

	private moveToInitialPosition(position: EditorSourcePosition): void {
		if (!Number.isSafeInteger(position.line) || position.line < 1 || position.line > this.buffer.lineCount) {
			throw new EditorPositionError("line-out-of-range", `Line ${position.line} is outside this ${this.buffer.lineCount}-line buffer`);
		}
		const lineLength = this.buffer.lineText(position.line).length;
		const maxCharacter = Math.max(lineLength, 1);
		if (!Number.isSafeInteger(position.character) || position.character < 1 || position.character > maxCharacter) {
			throw new EditorPositionError(
				"character-out-of-range",
				`Character ${position.character} is outside line ${position.line}'s ${lineLength} UTF-16 code units`,
			);
		}
		this.cursorLine = position.line;
		this.cursorCharacter = position.character;
	}

	get currentLineText(): string {
		return this.buffer.lineText(this.cursorLine);
	}

	handleKey(data: string): void {
		this.pendingAction = undefined;
		if (this.mode === "insert") {
			this.handleInsertKey(data);
		} else if (this.mode === "command") {
			this.handleCommandKey(data);
		} else {
			this.handleNormalKey(data);
		}
		this.clampCursor();
	}

	private clampCursor(): void {
		this.cursorLine = Math.min(Math.max(this.cursorLine, 1), this.buffer.lineCount);
		const lineLength = this.currentLineText.length;
		const maxCharacter = this.mode === "insert" ? lineLength + 1 : Math.max(lineLength, 1);
		this.cursorCharacter = Math.min(Math.max(this.cursorCharacter, 1), maxCharacter);
	}

	private enterInsert(): void {
		this.mode = "insert";
		this.insertPendingJ = false;
	}

	// ── Normal mode ──────────────────────────────────────────────────────────

	private handleNormalKey(data: string): void {
		// Two-key sequences: dd, gg, yy, ZZ, ZQ.
		if (this.normalPrefix) {
			const prefix = this.normalPrefix;
			this.normalPrefix = "";
			if (prefix === "d" && data === "d") {
				this.deleteCurrentLine();
				return;
			}
			if (prefix === "g" && data === "g") {
				this.cursorLine = 1;
				return;
			}
			if (prefix === "y" && data === "y") {
				this.yankedLine = this.currentLineText;
				return;
			}
			// Real vim's own close-on-demand mnemonics -- ZZ saves and quits (equivalent to :wq),
			// ZQ quits without saving (equivalent to :q). Added so a host never needs to invent its
			// own dismiss keybinding or reach into this class's internal mode/dirty state -- the
			// editor decides its own exit paths, exactly like :q/:wq already do.
			if (prefix === "Z" && data === "Z") {
				this.pendingAction = { kind: "save-and-quit" };
				return;
			}
			if (prefix === "Z" && data === "Q") {
				this.pendingAction = { kind: "quit" };
				return;
			}
			// Prefix didn't complete into a known sequence -- fall through and handle `data` fresh.
		}

		switch (data) {
			case "h":
				this.cursorCharacter -= 1;
				return;
			case "l":
				this.cursorCharacter += 1;
				return;
			case "k":
				this.cursorLine -= 1;
				return;
			case "j":
				this.cursorLine += 1;
				return;
			case "0":
				this.cursorCharacter = 1;
				return;
			case "$":
				this.cursorCharacter = Math.max(this.currentLineText.length, 1);
				return;
			case "G":
				this.cursorLine = this.buffer.lineCount;
				return;
			case "d":
			case "g":
			case "y":
			case "Z":
				this.normalPrefix = data;
				return;
			case "i":
				this.enterInsert();
				return;
			case "a":
				this.cursorCharacter += 1;
				this.enterInsert();
				return;
			case "I":
				this.cursorCharacter = 1;
				this.enterInsert();
				return;
			case "A":
				this.cursorCharacter = this.currentLineText.length + 1;
				this.enterInsert();
				return;
			case "o":
				this.openLine(this.cursorLine);
				return;
			case "O":
				this.openLine(this.cursorLine - 1);
				return;
			case "x":
				this.deleteCharUnderCursor();
				return;
			case "p":
				this.pasteYankedLine();
				return;
			case "u":
				this.buffer.undo();
				this.dirty = true;
				return;
			case "\x12": // Ctrl+R
				this.buffer.redo();
				this.dirty = true;
				return;
			case ":":
				this.mode = "command";
				this.commandText = "";
				return;
			case "\x13": // Ctrl+S
				this.pendingAction = { kind: "save" };
				return;
			case "K":
				this.pendingAction = { kind: "hover" };
				return;
			default:
				return;
		}
	}

	private openLine(afterLine: number): void {
		const offset = this.buffer.offsetAt({ line: Math.max(afterLine, 1), character: this.buffer.lineText(Math.max(afterLine, 1)).length + 1 });
		this.buffer.insert(offset, "\n");
		this.cursorLine = Math.max(afterLine, 1) + 1;
		this.cursorCharacter = 1;
		this.enterInsert();
		this.dirty = true;
	}

	private deleteCharUnderCursor(): void {
		const line = this.currentLineText;
		if (this.cursorCharacter > line.length) return;
		const from = this.buffer.offsetAt({ line: this.cursorLine, character: this.cursorCharacter });
		this.buffer.delete(from, from + 1);
		this.dirty = true;
	}

	private deleteCurrentLine(): void {
		const isLastLine = this.cursorLine === this.buffer.lineCount;
		const from = this.buffer.offsetAt({ line: this.cursorLine, character: 1 });
		const to = isLastLine
			? this.buffer.offsetAt({ line: this.cursorLine, character: this.currentLineText.length + 1 })
			: this.buffer.offsetAt({ line: this.cursorLine + 1, character: 1 });
		this.yankedLine = this.currentLineText;
		this.buffer.delete(from, to);
		if (isLastLine && this.cursorLine > 1) this.cursorLine -= 1;
		this.cursorCharacter = 1;
		this.dirty = true;
	}

	private pasteYankedLine(): void {
		if (this.yankedLine === undefined) return;
		const offset = this.buffer.offsetAt({ line: this.cursorLine, character: this.currentLineText.length + 1 });
		this.buffer.insert(offset, `\n${this.yankedLine}`);
		this.cursorLine += 1;
		this.cursorCharacter = 1;
		this.dirty = true;
	}

	// ── Insert mode ──────────────────────────────────────────────────────────

	private handleInsertKey(data: string): void {
		if (data === "\x1b") {
			this.insertPendingJ = false;
			this.mode = "normal";
			this.cursorCharacter = Math.max(this.cursorCharacter - 1, 1);
			return;
		}

		// "jk" chord exits insert without inserting either character -- mirrors the user's own
		// real Neovim muscle memory (`map("i", "jk", "<ESC>")`).
		if (this.insertPendingJ) {
			this.insertPendingJ = false;
			if (data === "k") {
				this.mode = "normal";
				return;
			}
			this.insertCharacter("j");
			// Fall through and handle `data` normally (it wasn't the "k" half of the chord).
		}
		if (data === "j" && data.length === 1) {
			this.insertPendingJ = true;
			return;
		}

		if (BACKSPACE_KEYS.has(data)) {
			this.backspace();
			return;
		}
		if (data === "\r" || data === "\n") {
			this.insertNewline();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
			return;
		}
		// Unhandled control sequence (arrow keys, etc.) -- ignored in this v1 walking skeleton.
	}

	private insertCharacter(char: string): void {
		const offset = this.buffer.offsetAt({ line: this.cursorLine, character: this.cursorCharacter });
		this.buffer.insert(offset, char);
		this.cursorCharacter += char.length;
		this.dirty = true;
	}

	private insertNewline(): void {
		const offset = this.buffer.offsetAt({ line: this.cursorLine, character: this.cursorCharacter });
		this.buffer.insert(offset, "\n");
		this.cursorLine += 1;
		this.cursorCharacter = 1;
		this.dirty = true;
	}

	private backspace(): void {
		if (this.cursorCharacter > 1) {
			const offset = this.buffer.offsetAt({ line: this.cursorLine, character: this.cursorCharacter });
			this.buffer.delete(offset - 1, offset);
			this.cursorCharacter -= 1;
			this.dirty = true;
			return;
		}
		if (this.cursorLine > 1) {
			const previousLineLength = this.buffer.lineText(this.cursorLine - 1).length;
			const offset = this.buffer.offsetAt({ line: this.cursorLine, character: 1 });
			this.buffer.delete(offset - 1, offset);
			this.cursorLine -= 1;
			this.cursorCharacter = previousLineLength + 1;
			this.dirty = true;
		}
	}

	// ── Command mode ─────────────────────────────────────────────────────────

	private handleCommandKey(data: string): void {
		if (data === "\x1b") {
			this.mode = "normal";
			this.commandText = "";
			return;
		}
		if (data === "\r" || data === "\n") {
			this.executeCommand(this.commandText);
			this.mode = "normal";
			this.commandText = "";
			return;
		}
		if (BACKSPACE_KEYS.has(data)) {
			if (this.commandText.length === 0) {
				this.mode = "normal";
				return;
			}
			this.commandText = this.commandText.slice(0, -1);
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.commandText += data;
		}
	}

	private executeCommand(command: string): void {
		switch (command) {
			case "w":
				this.pendingAction = { kind: "save" };
				return;
			case "q":
				this.pendingAction = { kind: "quit" };
				return;
			case "wq":
			case "x":
				this.pendingAction = { kind: "save-and-quit" };
				return;
			default:
				return;
		}
	}
}
