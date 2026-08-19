/**
 * Pure projection/render pair for the Caching widget -- mirrors pi-papyrus's own task-widget.ts /
 * pi-pipes' own jobs-widget.ts / pi-packed's own doctor-widget.ts split: the daemon's
 * workspace.activeCachingJobs result in, a bounded intermediate shape out, no I/O, no TUI, fully
 * unit-testable without a real daemon or terminal. See caching-overlay.ts for the stateful
 * ctx.ui.setWidget-registered class that drives these from a live poll.
 */
import { vehicleWidgetTitle } from "@danypops/vehicle-client-pi/widget-header";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type AutoRotatingWindow, renderCardRow, type TextMeasure } from "malevich-tui-components";

const measure: TextMeasure = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** The daemon's own manifest name (see packages/lector/src/service.ts's `new VehicleRegistry({ name: "lector" })`). */
const VEHICLE_NAME = "lector";

/** Visible rows per page before the auto-rotating overflow hint pages to the next. */
export const LECTOR_CACHING_WIDGET_VISIBLE_ROWS = 5;

export interface CachingWidgetRow {
	workspaceId: string;
	status: "queued" | "running" | "waiting-for-resources";
}

export interface CachingWidgetProjection {
	rows: CachingWidgetRow[];
	total: number;
}

export function buildCachingWidgetProjection(jobs: readonly CachingWidgetRow[]): CachingWidgetProjection {
	return { rows: [...jobs], total: jobs.length };
}

function cachingRowLine(theme: { fg(color: string, text: string): string }, row: CachingWidgetRow, width: number): string {
	const glyph =
		row.status === "waiting-for-resources"
			? theme.fg("warning", "\u23f8")
			: row.status === "queued"
				? theme.fg("muted", "\u2022")
				: theme.fg("accent", "\u25b6");
	return truncateToWidth(`${glyph} ${row.workspaceId}`, width, "\u2026");
}

/** "Lector · Caching · <N>", plus a "page/total ⟳" suffix once genuinely paging. */
function cachingCardLabel(projection: CachingWidgetProjection, rotation?: AutoRotatingWindow): string {
	const base = vehicleWidgetTitle(VEHICLE_NAME, "Caching", `${projection.total}`);
	return rotation?.isPaging ? `${base} \u00b7 ${rotation.pageIndex + 1}/${rotation.pageCount} \u27f3` : base;
}

/** Renders the widget as a single bordered card -- `[]` (hide the whole widget) when nothing is
 * currently caching, matching every other overlay's own "hide when nothing to show" convention. */
export function renderCachingWidgetLines(
	theme: { fg(color: string, text: string): string },
	projection: CachingWidgetProjection,
	width: number,
	rotation?: AutoRotatingWindow,
): string[] {
	if (projection.total === 0) return [];
	rotation?.setTotalRows(projection.rows.length);
	const { start, end } = rotation?.currentPageBounds() ?? { start: 0, end: projection.rows.length };
	const visibleRows = projection.rows.slice(start, end);

	return renderCardRow(
		[
			{
				label: cachingCardLabel(projection, rotation),
				render: (innerWidth: number) => visibleRows.map((row) => cachingRowLine(theme, row, innerWidth)),
			},
		],
		width,
		{ measure, frameStyle: (s) => theme.fg("borderMuted", s) },
	);
}
