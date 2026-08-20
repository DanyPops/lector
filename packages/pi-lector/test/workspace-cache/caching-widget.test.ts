import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AutoRotatingWindow } from "malevich-tui-components";
import { buildCachingWidgetProjection, renderCachingWidgetLines } from "../../extension/src/workspace-cache/caching-widget.ts";

const theme = { fg: (_color: string, text: string) => text } as { fg(color: string, text: string): string };

function rotation(pageSize: number, totalRows: number, now: () => number = () => 0): AutoRotatingWindow {
	return new AutoRotatingWindow({ totalRows, pageSize, intervalMs: 1000, now });
}

describe("buildCachingWidgetProjection", () => {
	it("returns zero rows when nothing is caching", () => {
		expect(buildCachingWidgetProjection([])).toEqual({ rows: [], total: 0 });
	});

	it("carries each active job's workspaceId and status through unchanged", () => {
		const projection = buildCachingWidgetProjection([
			{ workspaceId: "ws-a", status: "running" },
			{ workspaceId: "ws-b", status: "waiting-for-resources" },
		]);
		expect(projection.total).toBe(2);
		expect(projection.rows).toEqual([
			{ workspaceId: "ws-a", status: "running" },
			{ workspaceId: "ws-b", status: "waiting-for-resources" },
		]);
	});
});

describe("renderCachingWidgetLines", () => {
	it("returns no lines at all (hides the widget) when nothing is caching", () => {
		expect(renderCachingWidgetLines(theme, buildCachingWidgetProjection([]), 80)).toEqual([]);
	});

	it("renders a bordered card naming the owning Vehicle, the widget, and the active-job count, plus one line per workspace", () => {
		const projection = buildCachingWidgetProjection([{ workspaceId: "my-workspace", status: "running" }]);
		const lines = renderCachingWidgetLines(theme, projection, 80);
		expect(lines[0]).toContain("Lector · Caching · 1");
		expect(lines[0]).toContain("╭");
		expect(lines[lines.length - 1]).toContain("╰");
		expect(lines.some((line) => line.includes("my-workspace"))).toBe(true);
	});

	it("shows the project directory's own basename, not the bare workspaceId hash, when rootPath is known", () => {
		const projection = buildCachingWidgetProjection([{ workspaceId: "dee0f7308a7935fc", status: "running", rootPath: "/home/user/Projects/lector" }]);
		const lines = renderCachingWidgetLines(theme, projection, 80);
		expect(lines.some((line) => line.includes("lector"))).toBe(true);
		expect(lines.some((line) => line.includes("dee0f7308a7935fc"))).toBe(false);
	});

	it("falls back to the bare workspaceId when rootPath is absent", () => {
		const projection = buildCachingWidgetProjection([{ workspaceId: "dee0f7308a7935fc", status: "running" }]);
		const lines = renderCachingWidgetLines(theme, projection, 80);
		expect(lines.some((line) => line.includes("dee0f7308a7935fc"))).toBe(true);
	});

	it("shows a real files-processed/files-total fraction when progress is known, nothing extra when it is not", () => {
		const withProgress = buildCachingWidgetProjection([
			{ workspaceId: "a", status: "running", rootPath: "/home/user/proj-a", progress: { filesProcessed: 142, filesTotal: 500 } },
		]);
		const linesWithProgress = renderCachingWidgetLines(theme, withProgress, 80);
		expect(linesWithProgress.some((line) => line.includes("(142/500)"))).toBe(true);

		const withoutProgress = buildCachingWidgetProjection([{ workspaceId: "b", status: "queued", rootPath: "/home/user/proj-b" }]);
		const linesWithoutProgress = renderCachingWidgetLines(theme, withoutProgress, 80);
		expect(linesWithoutProgress.some((line) => line.includes("("))).toBe(false);
	});

	it("shows a distinguishable marker for a job waiting on resource admission vs a genuinely running one", () => {
		const projection = buildCachingWidgetProjection([
			{ workspaceId: "running-ws", status: "running" },
			{ workspaceId: "waiting-ws", status: "waiting-for-resources" },
		]);
		const lines = renderCachingWidgetLines(theme, projection, 80);
		const runningLine = lines.find((line) => line.includes("running-ws"));
		const waitingLine = lines.find((line) => line.includes("waiting-ws"));
		expect(runningLine).toBeDefined();
		expect(waitingLine).toBeDefined();
		expect(runningLine).not.toBe(waitingLine);
	});

	it("never produces a line wider than the given width", () => {
		const projection = buildCachingWidgetProjection([{ workspaceId: "x".repeat(200), status: "running" }]);
		for (const width of [40, 80, 120]) {
			for (const line of renderCachingWidgetLines(theme, projection, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	describe("auto-rotating overflow hint", () => {
		it("never shows a page hint when every active job already fits on one page", () => {
			const projection = buildCachingWidgetProjection([{ workspaceId: "a", status: "running" }]);
			const lines = renderCachingWidgetLines(theme, projection, 80, rotation(5, 1));
			expect(lines[0]).not.toMatch(/\d\/\d ⟳/);
		});

		it("shows a page/total rotation hint once active jobs genuinely outgrow one page, and pages through them as the clock advances", () => {
			const rows = Array.from({ length: 5 }, (_, i) => ({ workspaceId: `ws-${i}`, status: "running" as const }));
			const projection = buildCachingWidgetProjection(rows);
			let now = 0;
			const paging = rotation(2, 5, () => now);

			const page1 = renderCachingWidgetLines(theme, projection, 80, paging);
			expect(page1[0]).toMatch(/1\/3 ⟳/);

			now = 1000;
			const page2 = renderCachingWidgetLines(theme, projection, 80, paging);
			expect(page2[0]).toMatch(/2\/3 ⟳/);
		});
	});
});
