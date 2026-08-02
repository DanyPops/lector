import type { SymbolAnnotation } from "@danypops/lector";
import type { LectorTheme } from "../lector-tui-theme.ts";

const STATUS_COLOR: Record<SymbolAnnotation["status"], "success" | "warning" | "dim"> = {
	fresh: "success",
	stale: "warning",
	scrubbed: "dim",
};

/** One-line summary: status, title, subtype, id, anchor count -- the body is intentionally omitted (it can be long prose; the tool result's own text content carries it in full). */
export function formatAnnotationSummary(annotation: SymbolAnnotation, theme: LectorTheme): string {
	const status = theme.fg(STATUS_COLOR[annotation.status], `[${annotation.status}]`);
	const anchorCount = `${annotation.anchors.length} anchor${annotation.anchors.length === 1 ? "" : "s"}`;
	return `${status} ${theme.bold(annotation.title)} ${theme.fg("muted", `(${annotation.subtype})`)} -- ${anchorCount} -- ${theme.fg("dim", annotation.id)}`;
}

/** Full text for a tool result: summary line, body, and every anchor's exact symbol position. */
export function formatAnnotationDetail(annotation: SymbolAnnotation): string {
	const anchorLines = annotation.anchors.map((anchor) => `  - ${anchor.symbolNodeId}`).join("\n");
	return `[${annotation.status}] ${annotation.title} (${annotation.subtype})\nid: ${annotation.id}\n\n${annotation.body}\n\nAnchors:\n${anchorLines}`;
}

export function formatAnnotationListSummary(annotations: readonly SymbolAnnotation[], theme: LectorTheme): string {
	if (annotations.length === 0) return theme.fg("muted", "no annotations");
	return annotations.map((annotation) => formatAnnotationSummary(annotation, theme)).join("\n");
}
