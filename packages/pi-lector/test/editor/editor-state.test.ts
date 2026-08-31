import { describe, expect, it } from "bun:test";
import { EditorState } from "../../extension/src/editor/editor-state.ts";

describe("EditorState", () => {
	it("starts in normal mode at line 1, character 1", () => {
		const state = new EditorState("hello\nworld");
		expect(state.mode).toBe("normal");
		expect(state.cursorLine).toBe(1);
		expect(state.cursorCharacter).toBe(1);
	});

	it("starts at a validated UTF-16 source position", () => {
		const state = new EditorState("alpha\nA😀B\nomega", { line: 2, character: 4 });
		expect(state.cursorLine).toBe(2);
		expect(state.cursorCharacter).toBe(4);
	});

	it("rejects an out-of-range source position", () => {
		expect(() => new EditorState("alpha\nomega", { line: 3, character: 1 })).toThrow("line-out-of-range");
		expect(() => new EditorState("alpha\nomega", { line: 2, character: 6 })).toThrow("character-out-of-range");
	});

	describe("normal mode motions", () => {
		it("h/j/k/l move the cursor", () => {
			const state = new EditorState("abc\ndef\nghi");
			state.handleKey("l");
			expect(state.cursorCharacter).toBe(2);
			state.handleKey("j");
			expect(state.cursorLine).toBe(2);
			state.handleKey("h");
			expect(state.cursorCharacter).toBe(1);
			state.handleKey("k");
			expect(state.cursorLine).toBe(1);
		});

		it("does not move left of column 1 or above line 1", () => {
			const state = new EditorState("abc");
			state.handleKey("h");
			state.handleKey("k");
			expect(state.cursorLine).toBe(1);
			expect(state.cursorCharacter).toBe(1);
		});

		it("0 moves to line start, $ moves to line end", () => {
			const state = new EditorState("abcde");
			state.handleKey("l");
			state.handleKey("l");
			state.handleKey("$");
			expect(state.cursorCharacter).toBe(5);
			state.handleKey("0");
			expect(state.cursorCharacter).toBe(1);
		});

		it("gg moves to buffer start, G moves to buffer end", () => {
			const state = new EditorState("a\nb\nc");
			state.handleKey("G");
			expect(state.cursorLine).toBe(3);
			state.handleKey("g");
			state.handleKey("g");
			expect(state.cursorLine).toBe(1);
		});
	});

	describe("mode transitions", () => {
		it("i enters insert mode without moving the cursor", () => {
			const state = new EditorState("abc");
			state.handleKey("l");
			state.handleKey("i");
			expect(state.mode).toBe("insert");
			expect(state.cursorCharacter).toBe(2);
		});

		it("a enters insert mode one character to the right", () => {
			const state = new EditorState("abc");
			state.handleKey("a");
			expect(state.mode).toBe("insert");
			expect(state.cursorCharacter).toBe(2);
		});

		it("A enters insert mode at the end of the line", () => {
			const state = new EditorState("abc");
			state.handleKey("A");
			expect(state.mode).toBe("insert");
			expect(state.cursorCharacter).toBe(4);
		});

		it("I enters insert mode at the start of the line", () => {
			const state = new EditorState("abc");
			state.handleKey("l");
			state.handleKey("I");
			expect(state.mode).toBe("insert");
			expect(state.cursorCharacter).toBe(1);
		});

		it("o opens a new line below and enters insert mode", () => {
			const state = new EditorState("abc\ndef");
			state.handleKey("o");
			expect(state.mode).toBe("insert");
			expect(state.buffer.lineCount).toBe(3);
			expect(state.cursorLine).toBe(2);
			expect(state.buffer.text).toBe("abc\n\ndef");
		});

		it("escape returns to normal mode from insert", () => {
			const state = new EditorState("abc");
			state.handleKey("i");
			state.handleKey("\x1b");
			expect(state.mode).toBe("normal");
		});

		it("jk exits insert mode without inserting either character", () => {
			const state = new EditorState("abc");
			state.handleKey("i");
			state.handleKey("j");
			state.handleKey("k");
			expect(state.mode).toBe("normal");
			expect(state.buffer.text).toBe("abc");
		});

		it("a lone j (not followed by k) is inserted literally", () => {
			const state = new EditorState("abc");
			state.handleKey("i");
			state.handleKey("j");
			state.handleKey("x");
			expect(state.buffer.text).toBe("jxabc");
		});
	});

	describe("editing", () => {
		it("x deletes the character under the cursor", () => {
			const state = new EditorState("abc");
			state.handleKey("x");
			expect(state.buffer.text).toBe("bc");
		});

		it("insert mode types printable characters at the cursor", () => {
			const state = new EditorState("ac");
			state.handleKey("l");
			state.handleKey("i");
			state.handleKey("b");
			expect(state.buffer.text).toBe("abc");
			expect(state.cursorCharacter).toBe(3);
		});

		it("insert mode backspace deletes the character before the cursor", () => {
			const state = new EditorState("abc");
			state.handleKey("A");
			state.handleKey("\x7f");
			expect(state.buffer.text).toBe("ab");
		});

		it("dd deletes the current line", () => {
			const state = new EditorState("a\nb\nc");
			state.handleKey("j");
			state.handleKey("d");
			state.handleKey("d");
			expect(state.buffer.text).toBe("a\nc");
		});

		it("yy then p yanks and pastes the current line below", () => {
			const state = new EditorState("a\nb");
			state.handleKey("y");
			state.handleKey("y");
			state.handleKey("p");
			expect(state.buffer.text).toBe("a\na\nb");
		});

		it("u undoes the most recent edit", () => {
			const state = new EditorState("abc");
			state.handleKey("x");
			expect(state.buffer.text).toBe("bc");
			state.handleKey("u");
			expect(state.buffer.text).toBe("abc");
		});
	});

	describe("command mode", () => {
		it(": enters command mode", () => {
			const state = new EditorState("abc");
			state.handleKey(":");
			expect(state.mode).toBe("command");
		});

		it(":w requests a save action and returns to normal mode", () => {
			const state = new EditorState("abc");
			state.handleKey(":");
			state.handleKey("w");
			state.handleKey("\r");
			expect(state.pendingAction).toEqual({ kind: "save" });
			expect(state.mode).toBe("normal");
		});

		it(":q requests a quit action", () => {
			const state = new EditorState("abc");
			state.handleKey(":");
			state.handleKey("q");
			state.handleKey("\r");
			expect(state.pendingAction).toEqual({ kind: "quit" });
		});

		it(":wq requests a save-and-quit action", () => {
			const state = new EditorState("abc");
			state.handleKey(":");
			state.handleKey("w");
			state.handleKey("q");
			state.handleKey("\r");
			expect(state.pendingAction).toEqual({ kind: "save-and-quit" });
		});

		it("escape cancels command mode without an action", () => {
			const state = new EditorState("abc");
			state.handleKey(":");
			state.handleKey("w");
			state.handleKey("\x1b");
			expect(state.mode).toBe("normal");
			expect(state.pendingAction).toBeUndefined();
		});

		it("ctrl+s requests a save action directly from normal mode", () => {
			const state = new EditorState("abc");
			state.handleKey("\x13");
			expect(state.pendingAction).toEqual({ kind: "save" });
		});
	});

	describe("close-on-demand (ZZ/ZQ)", () => {
		it("ZZ requests a save-and-quit action, same as :wq", () => {
			const state = new EditorState("abc");
			state.handleKey("Z");
			state.handleKey("Z");
			expect(state.pendingAction).toEqual({ kind: "save-and-quit" });
			expect(state.mode).toBe("normal");
		});

		it("ZQ requests a quit action, same as :q", () => {
			const state = new EditorState("abc");
			state.handleKey("Z");
			state.handleKey("Q");
			expect(state.pendingAction).toEqual({ kind: "quit" });
			expect(state.mode).toBe("normal");
		});

		it("a lone Z (not followed by Z or Q) falls through and is handled fresh, not treated as an exit", () => {
			const state = new EditorState("abc");
			state.handleKey("Z");
			state.handleKey("i"); // fall-through key: enters insert mode, same as a bare "i" would
			expect(state.pendingAction).toBeUndefined();
			expect(state.mode).toBe("insert");
		});
	});

	describe("code intelligence", () => {
		it("K requests a hover action", () => {
			const state = new EditorState("abc");
			state.handleKey("K");
			expect(state.pendingAction).toEqual({ kind: "hover" });
		});
	});
});
