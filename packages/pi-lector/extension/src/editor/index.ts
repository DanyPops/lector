/**
 * The real, host-agnostic editor surface -- deliberately its own subpath export
 * (`@danypops/pi-lector/editor`), not part of this package's own Pi extension entry point
 * (`extension/src/index.ts`, which is loaded only via Pi's own extension-discovery mechanism and
 * has no package export of its own).
 *
 * Everything re-exported here has zero structural dependency on Pi's extension machinery --
 * confirmed directly: ModalEditorComponent's own constructor only ever calls
 * `tui.requestRender()`/`tui.terminal.rows` and `theme.fg()`/`theme.bg()` (EditorTheme is its own
 * interface, deliberately narrowed away from pi-coding-agent's full Theme shape), and
 * ModalEditorHost is a plain `{filePath, save, hover}` port with no Pi types anywhere in it.
 * EditorState's own only dependency is `@danypops/lector`'s LiveBuffer -- no I/O, no rendering.
 *
 * This lets any real host (not just a Pi session that has loaded this package as an extension)
 * construct and mount a real Lector editor Component directly, against its own tui/theme
 * implementation and its own ModalEditorHost backed by whatever it wants (a Lector daemon
 * client, a Vehicle operation, a plain filesystem call -- this package doesn't care).
 *
 * The same holds for ExplorerComponent (the oil.nvim-style directory explorer, built on the same
 * EditorState engine): it only depends on `tui`/`theme` plus a DirectoryExplorerSession, its own
 * real external contract. DirectoryExplorerSession happens to be declared alongside
 * openDirectoryExplorer in directory-explorer-operations.ts, but the two are not the same kind of
 * thing -- exactly the ModalEditorHost/openEditorFile split repeats here. openDirectoryExplorer
 * (and openEditorFile) are this package's OWN Pi-extension-internal construction helpers, built on
 * this package's own lectorClient()/withWorkspace -- deliberately not exported. A real external
 * host is expected to supply its own DirectoryExplorerSession implementation, backed by whatever
 * it wants, the same way Alignment's own ModalEditorHost implementation never reuses
 * openEditorFile either.
 */

export { type EditorAction, type EditorMode, EditorState } from "./editor-state.ts";
export type { EditorTheme } from "./editor-theme.ts";
export { ModalEditorComponent, type ModalEditorHost } from "./modal-editor-component.ts";
export { ExplorerComponent, type ExplorerResult, joinExplorerPath } from "./explorer-component.ts";
export type { DirectoryExplorerSession } from "./directory-explorer-operations.ts";
