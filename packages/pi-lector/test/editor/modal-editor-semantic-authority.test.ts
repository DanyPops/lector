import { describe, expect, it } from "bun:test";
import { contentHashOf } from "@danypops/lector";
import type { TUI } from "@earendil-works/pi-tui";
import type { EditorTheme } from "../../extension/src/editor/editor-theme.ts";
import { type EditorHoverRequest, ModalEditorComponent } from "../../extension/src/editor/modal-editor-component.ts";

const fakeTheme: EditorTheme = { fg: (_color, text) => text } as EditorTheme;

function fakeTui(): TUI {
	return { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function typeKeys(component: ModalEditorComponent, keys: readonly string[]): void {
	for (const key of keys) component.handleInput(key);
}

describe("ModalEditorComponent semantic authority", () => {
	it("passes the dirty buffer snapshot to hover", async () => {
		let request: EditorHoverRequest | undefined;
		const component = new ModalEditorComponent(
			fakeTui(),
			fakeTheme,
			{
				filePath: "/repo/src/state.ts",
				save: async () => undefined,
				hover: async () => undefined,
				hoverSnapshot: async (candidate) => {
					request = candidate;
					return { kind: "stale-active-buffer", bufferHash: candidate.buffer.hash };
				},
			},
			"export const stableValue = 1;\n",
			() => undefined,
		);
		await tick();

		typeKeys(component, ["o", ...'export const dirtyOnly = "active";', "\x1b", "0", ...Array(13).fill("l"), "K"]);
		await tick();

		const expectedText = 'export const stableValue = 1;\nexport const dirtyOnly = "active";\n';
		expect(request).toEqual({
			line: 2,
			character: 14,
			buffer: { text: expectedText, hash: contentHashOf(expectedText), dirty: true },
		});
		expect(component.render(80).join("\n")).toContain("stale active buffer");
	});
});
