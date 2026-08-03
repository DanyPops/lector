import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** Real theme, narrowed to exactly what the editor/explorer components need -- avoids depending on pi-coding-agent's full internal Theme shape. */
export interface EditorTheme {
	fg(color: ThemeColor, text: string): string;
	bg(color: "selectedBg", text: string): string;
}
