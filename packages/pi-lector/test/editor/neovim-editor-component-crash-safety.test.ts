/**
 * Crash-safety coverage for NeovimEditorComponent's own fire-and-forget async dispatch (handleInput
 * -> performAction, and the constructor/render's own refreshHighlights trigger) -- the same defect
 * class found and fixed in ExplorerComponent (see explorer-crash-safety.test.ts): a host callback
 * (save/hover) rejecting must surface as a status message, never escape as an unhandled rejection
 * that would crash the whole Pi process.
 */
import { describe, expect, it } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import type { EditorTheme } from "../../extension/src/editor/editor-theme.ts";
import { NeovimEditorComponent } from "../../extension/src/editor/neovim-editor-component.ts";

const fakeTheme: EditorTheme = { fg: (_color, text) => text } as EditorTheme;

function fakeTui(): TUI {
	return { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("NeovimEditorComponent crash safety", () => {
	it("surfaces a failing hover as a status message instead of an unhandled rejection", async () => {
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const component = new NeovimEditorComponent(
				fakeTui(),
				fakeTheme,
				{
					filePath: "/repo/src/index.ts",
					save: async () => undefined,
					hover: async () => {
						throw new Error("daemon unreachable");
					},
				},
				"const x = 1;\n",
				() => undefined,
			);
			await tick();

			component.handleInput("K"); // triggers the "hover" pendingAction
			await tick();

			expect(component.render(80).join("\n")).toContain("daemon unreachable");
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandledRejections).toEqual([]);
	});

	it("surfaces a failing save as a status message instead of an unhandled rejection", async () => {
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const component = new NeovimEditorComponent(
				fakeTui(),
				fakeTheme,
				{
					filePath: "/repo/src/index.ts",
					save: async () => {
						throw new Error("stale hash");
					},
					hover: async () => undefined,
				},
				"const x = 1;\n",
				() => undefined,
			);
			await tick();

			component.handleInput("\x13"); // Ctrl+S -- triggers the "save" pendingAction
			await tick();

			expect(component.render(80).join("\n")).toContain("save failed: stale hash");
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandledRejections).toEqual([]);
	});
});
