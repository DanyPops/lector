/**
 * The real, host-agnostic editor surface -- deliberately its own subpath export
 * (`@danypops/pi-lector/editor`), not part of this package's own Pi extension entry point
 * (`extension/src/index.ts`, which is loaded only via Pi's own extension-discovery mechanism and
 * has no package export of its own).
 *
 * Everything re-exported here has zero structural dependency on Pi's extension machinery --
 * confirmed directly: NeovimEditorComponent's own constructor only ever calls
 * `tui.requestRender()`/`tui.terminal.rows` and `theme.fg()`/`theme.bg()` (EditorTheme is its own
 * interface, deliberately narrowed away from pi-coding-agent's full Theme shape), and
 * NeovimEditorHost is a plain `{filePath, save, hover}` port with no Pi types anywhere in it.
 * EditorState's own only dependency is `@danypops/lector`'s LiveBuffer -- no I/O, no rendering.
 *
 * This lets any real host (not just a Pi session that has loaded this package as an extension)
 * construct and mount a real Lector editor Component directly, against its own tui/theme
 * implementation and its own NeovimEditorHost backed by whatever it wants (a Lector daemon
 * client, a Vehicle operation, a plain filesystem call -- this package doesn't care).
 */
export { NeovimEditorComponent, type NeovimEditorHost } from "./neovim-editor-component.ts";
export type { EditorTheme } from "./editor-theme.ts";
export { EditorState, type EditorAction, type EditorMode } from "./editor-state.ts";
