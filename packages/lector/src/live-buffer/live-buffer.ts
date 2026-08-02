import { ChangeSet, Text } from "@codemirror/state";

/**
 * A position inside a LiveBuffer. Deliberately 1-indexed for both fields, matching
 * WorkspaceLocation's existing convention elsewhere in Lector's domain (the LSP adapters
 * already convert LSP's own 0-indexed positions to this same 1-indexed shape) -- so a position
 * read from LiveBuffer can be handed directly to hover/goToDefinition/etc. without a second
 * conversion step.
 */
export interface BufferPosition {
	readonly line: number;
	readonly character: number;
}

/**
 * A live, in-memory, rope-backed text buffer for an open interactive editing session --
 * @codemirror/state's Text+ChangeSet (see Doc "Lector owns FS/Git/Code manipulation domain"
 * and Doc "Lector TUI code editor: off-the-shelf survey and lift/build plan"). This buffer is
 * never itself a second source of truth: whichever caller opens one is responsible for
 * committing its final text back through WorkspacePort's hash-guarded write on save, exactly
 * like every other Lector edit path -- LiveBuffer only owns what happens between open and save.
 */
export class LiveBuffer {
	private doc: Text;
	private readonly undoStack: ChangeSet[] = [];
	private readonly redoStack: ChangeSet[] = [];

	constructor(content: string) {
		this.doc = Text.of(content.split("\n"));
	}

	get text(): string {
		return this.doc.toString();
	}

	get lineCount(): number {
		return this.doc.lines;
	}

	get length(): number {
		return this.doc.length;
	}

	/** 1-indexed line number -> that line's text, excluding its line break. */
	lineText(line: number): string {
		return this.doc.line(this.clampLine(line)).text;
	}

	offsetAt(position: BufferPosition): number {
		const lineInfo = this.doc.line(this.clampLine(position.line));
		const character = Math.min(Math.max(position.character - 1, 0), lineInfo.length);
		return lineInfo.from + character;
	}

	positionAt(offset: number): BufferPosition {
		const clamped = Math.min(Math.max(offset, 0), this.doc.length);
		const lineInfo = this.doc.lineAt(clamped);
		return { line: lineInfo.number, character: clamped - lineInfo.from + 1 };
	}

	insert(offset: number, text: string): void {
		this.applyChange({ from: offset, insert: text });
	}

	delete(from: number, to: number): void {
		this.applyChange({ from, to });
	}

	replace(from: number, to: number, text: string): void {
		this.applyChange({ from, to, insert: text });
	}

	/** Reverts the most recent change. Returns false when there is nothing left to undo. */
	undo(): boolean {
		const change = this.undoStack.pop();
		if (!change) return false;
		const redoChange = change.invert(this.doc);
		this.doc = change.apply(this.doc);
		this.redoStack.push(redoChange);
		return true;
	}

	/** Re-applies the most recently undone change. Returns false when there is nothing to redo. */
	redo(): boolean {
		const change = this.redoStack.pop();
		if (!change) return false;
		const undoChange = change.invert(this.doc);
		this.doc = change.apply(this.doc);
		this.undoStack.push(undoChange);
		return true;
	}

	private clampLine(line: number): number {
		return Math.min(Math.max(line, 1), this.doc.lines);
	}

	private applyChange(spec: { from: number; to?: number; insert?: string }): void {
		const changes = ChangeSet.of(spec, this.doc.length);
		const inverted = changes.invert(this.doc);
		this.doc = changes.apply(this.doc);
		this.undoStack.push(inverted);
		this.redoStack.length = 0;
	}
}
