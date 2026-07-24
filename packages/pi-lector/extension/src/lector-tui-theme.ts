import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * The minimal slice of pi-coding-agent's real Theme class every Lector-tool
 * rendering module in this package actually uses -- not the full class
 * (15+ methods, private fields). Narrower, and a plain pass-through object
 * satisfies it directly in tests with no cast, since Theme's real fg/bold
 * already structurally match. Shared across find_symbols, document_symbols,
 * go_to_definition, find_references, and hover's rendering so each doesn't
 * redeclare the same interface.
 */
export interface LectorTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

/** Maps a symbol/declaration kind to the closest semantic syntax-highlighting color already in the theme palette. */
const KIND_COLOR: Record<string, ThemeColor> = {
	function: "syntaxFunction",
	method: "syntaxFunction",
	class: "syntaxType",
	interface: "syntaxType",
	"type-alias": "syntaxType",
	enum: "syntaxType",
	variable: "syntaxVariable",
};

export function colorForKind(kind: string): ThemeColor {
	return KIND_COLOR[kind] ?? "muted";
}

/** `path:line:character`, dimmed -- the one consistent way every Lector tool renders a file position. */
export function formatLocation(theme: LectorTheme, path: string, line: number, character: number): string {
	return theme.fg("dim", `${path}:${line}:${character}`);
}
