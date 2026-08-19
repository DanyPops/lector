/**
 * Persistent above-editor widget for currently-active symbol-graph caching jobs -- mirrors
 * pi-papyrus's own TaskOverlay/NoteOverlay, pi-pipes' own JobsOverlay, and pi-packed's own
 * DoctorOverlay: factory-form ctx.ui.setWidget registration, requestRender on refresh, hides the
 * widget entirely (setWidget(key, undefined)) rather than an empty box once nothing is caching.
 *
 * workspace.activeCachingJobs enumerates every workspace with a currently active (queued/
 * running) population job -- see packages/lector/src/service/symbol-graph/cache-query-handlers.ts.
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { BoundedPoll } from "../bounded-poll.js";
import { lectorClient, type RetryingLectorClient } from "../lector-client.js";
import { buildCachingWidgetProjection, type CachingWidgetProjection, LECTOR_CACHING_WIDGET_VISIBLE_ROWS, renderCachingWidgetLines } from "./caching-widget.js";

const WIDGET_KEY = "pi-lector-caching";

/** Matches pi-papyrus's/pi-pipes' own 15-20s cadence -- workspace.activeCachingJobs is a cheap in-memory read. */
export const CACHING_WIDGET_POLL_INTERVAL_MS = 15_000;

/** How often the widget's own auto-rotating overflow page advances. */
export const CACHING_WIDGET_ROTATION_INTERVAL_MS = 6_000;

const EMPTY_PROJECTION: CachingWidgetProjection = { rows: [], total: 0 };

export class CachingOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: TUI | undefined;
	private projection: CachingWidgetProjection = EMPTY_PROJECTION;
	private readonly poll = new BoundedPoll();
	/** Repaint-only ticker (no data refetch) so the widget's own auto-rotating page visibly
	 * advances even when nothing else has changed. */
	private readonly rotationPoll = new BoundedPoll();
	private readonly rotation = new AutoRotatingWindow({
		totalRows: 0,
		pageSize: LECTOR_CACHING_WIDGET_VISIBLE_ROWS,
		intervalMs: CACHING_WIDGET_ROTATION_INTERVAL_MS,
	});

	constructor(private readonly connect: () => Promise<RetryingLectorClient> = lectorClient) {}

	setUI(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	/** Never throws: called from a poll timer and from session_start, neither of which should turn
	 * a best-effort status widget into a crashed extension host over a daemon that isn't running
	 * yet or a rendering bug. */
	async refresh(): Promise<void> {
		try {
			const client = await this.connect();
			const result = await client.call("workspace.activeCachingJobs", {});
			this.projection = buildCachingWidgetProjection(result.jobs);
		} catch {
			this.projection = EMPTY_PROJECTION;
		}
		try {
			this.render();
		} catch {
			// A rendering bug must not crash the extension host over a best-effort status widget.
		}
	}

	private render(): void {
		if (!this.uiCtx) return;

		if (this.projection.total === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
				this.rotationPoll.stop();
			}
			return;
		}

		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui: TUI, theme: Theme) => {
					this.tui = tui;
					return {
						render: (width: number) => renderCachingWidgetLines(theme, this.projection, width, this.rotation),
						invalidate: () => {
							// Theme changed -- force re-registration, matching every other overlay in this ecosystem.
							this.registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
			this.rotationPoll.start(CACHING_WIDGET_ROTATION_INTERVAL_MS, () => this.tui?.requestRender());
		} else {
			this.tui?.requestRender();
		}
	}

	startPolling(intervalMs: number = CACHING_WIDGET_POLL_INTERVAL_MS): void {
		this.poll.start(intervalMs, () => {
			void this.refresh();
		});
	}

	stopPolling(): void {
		this.poll.stop();
	}

	dispose(): void {
		this.stopPolling();
		this.rotationPoll.stop();
		this.uiCtx?.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
	}
}
