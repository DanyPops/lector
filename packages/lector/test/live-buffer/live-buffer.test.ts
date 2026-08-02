import { describe, expect, it } from "bun:test";
import { LiveBuffer } from "../../src/live-buffer/live-buffer.ts";

describe("LiveBuffer", () => {
	it("starts with the given content and reports its line count", () => {
		const buffer = new LiveBuffer("a\nb\nc");
		expect(buffer.text).toBe("a\nb\nc");
		expect(buffer.lineCount).toBe(3);
		expect(buffer.length).toBe(5);
	});

	it("reports 1-indexed line text", () => {
		const buffer = new LiveBuffer("first\nsecond\nthird");
		expect(buffer.lineText(1)).toBe("first");
		expect(buffer.lineText(2)).toBe("second");
		expect(buffer.lineText(3)).toBe("third");
	});

	it("converts a 1-indexed line/character position to an absolute offset", () => {
		const buffer = new LiveBuffer("ab\ncd\nef");
		expect(buffer.offsetAt({ line: 1, character: 1 })).toBe(0);
		expect(buffer.offsetAt({ line: 1, character: 3 })).toBe(2); // end of "ab"
		expect(buffer.offsetAt({ line: 2, character: 1 })).toBe(3); // start of "cd"
		expect(buffer.offsetAt({ line: 3, character: 2 })).toBe(7); // 'f' in "ef"
	});

	it("converts an absolute offset back to a 1-indexed line/character position", () => {
		const buffer = new LiveBuffer("ab\ncd\nef");
		expect(buffer.positionAt(0)).toEqual({ line: 1, character: 1 });
		expect(buffer.positionAt(3)).toEqual({ line: 2, character: 1 });
		expect(buffer.positionAt(7)).toEqual({ line: 3, character: 2 });
	});

	it("inserts text at an offset", () => {
		const buffer = new LiveBuffer("hello world");
		buffer.insert(5, ",");
		expect(buffer.text).toBe("hello, world");
	});

	it("deletes a range", () => {
		const buffer = new LiveBuffer("hello world");
		buffer.delete(5, 11);
		expect(buffer.text).toBe("hello");
	});

	it("replaces a range", () => {
		const buffer = new LiveBuffer("hello world");
		buffer.replace(6, 11, "there");
		expect(buffer.text).toBe("hello there");
	});

	it("undoes the most recent change", () => {
		const buffer = new LiveBuffer("hello");
		buffer.insert(5, " world");
		expect(buffer.text).toBe("hello world");
		expect(buffer.undo()).toBe(true);
		expect(buffer.text).toBe("hello");
	});

	it("redoes an undone change", () => {
		const buffer = new LiveBuffer("hello");
		buffer.insert(5, " world");
		buffer.undo();
		expect(buffer.redo()).toBe(true);
		expect(buffer.text).toBe("hello world");
	});

	it("undo is false when there is nothing to undo", () => {
		const buffer = new LiveBuffer("hello");
		expect(buffer.undo()).toBe(false);
	});

	it("redo is false when there is nothing to redo", () => {
		const buffer = new LiveBuffer("hello");
		buffer.insert(5, "!");
		expect(buffer.redo()).toBe(false);
	});

	it("a new edit after undo clears the redo stack", () => {
		const buffer = new LiveBuffer("hello");
		buffer.insert(5, " world");
		buffer.undo();
		buffer.insert(5, "!");
		expect(buffer.redo()).toBe(false);
		expect(buffer.text).toBe("hello!");
	});

	it("undoes multiple changes in reverse order", () => {
		const buffer = new LiveBuffer("a");
		buffer.insert(1, "b");
		buffer.insert(2, "c");
		expect(buffer.text).toBe("abc");
		buffer.undo();
		expect(buffer.text).toBe("ab");
		buffer.undo();
		expect(buffer.text).toBe("a");
	});
});
