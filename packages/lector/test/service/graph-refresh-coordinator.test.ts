import { describe, expect, it } from "bun:test";
import { GraphRefreshCoordinator, GraphRefreshJobActive } from "../../src/service/graph-refresh-coordinator.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";

class RecordingScheduler {
	readonly callbacks = new Map<string, () => void>();
	schedule(key: string, callback: () => void): void {
		this.callbacks.set(key, callback);
	}
	cancel(key: string): void {
		this.callbacks.delete(key);
	}
	clear(): void {
		this.callbacks.clear();
	}
	flush(): void {
		for (const callback of this.callbacks.values()) callback();
		this.callbacks.clear();
	}
}

describe("GraphRefreshCoordinator", () => {
	it("owns one graph per workspace and closes every graph", async () => {
		let creates = 0;
		let closes = 0;
		const coordinator = new GraphRefreshCoordinator({
			debounceMs: 10,
			createGraph: () => {
				creates += 1;
				const graph = new InMemorySymbolGraph();
				const close = graph.close.bind(graph);
				graph.close = async () => {
					closes += 1;
					await close();
				};
				return graph;
			},
		});

		expect(coordinator.graph("workspace-a")).toBe(coordinator.graph("workspace-a"));
		coordinator.graph("workspace-b");
		expect(creates).toBe(2);
		await coordinator.close();
		expect(closes).toBe(2);
	});

	it("tracks graph watching and active population jobs by workspace", () => {
		const coordinator = new GraphRefreshCoordinator({ debounceMs: 10, createGraph: () => new InMemorySymbolGraph() });
		coordinator.markWatched("workspace-a");
		coordinator.setActiveJob("workspace-a", "job-1");
		expect(coordinator.isWatched("workspace-a")).toBe(true);
		expect(coordinator.activeJob("workspace-a")).toBe("job-1");
		coordinator.clearActiveJob("workspace-a", "another-job");
		expect(coordinator.activeJob("workspace-a")).toBe("job-1");
		coordinator.clearActiveJob("workspace-a", "job-1");
		expect(coordinator.activeJob("workspace-a")).toBeUndefined();
	});

	it("activeJobEntries() enumerates every workspace with a currently active job, none that have already cleared", () => {
		const coordinator = new GraphRefreshCoordinator({ debounceMs: 10, createGraph: () => new InMemorySymbolGraph() });
		expect(coordinator.activeJobEntries()).toEqual([]);

		coordinator.setActiveJob("workspace-a", "job-1");
		coordinator.setActiveJob("workspace-b", "job-2");
		expect(coordinator.activeJobEntries().sort()).toEqual([
			["workspace-a", "job-1"],
			["workspace-b", "job-2"],
		]);

		coordinator.clearActiveJob("workspace-a", "job-1");
		expect(coordinator.activeJobEntries()).toEqual([["workspace-b", "job-2"]]);
	});

	it("coalesces refresh scheduling per workspace through one debouncer", () => {
		const scheduler = new RecordingScheduler();
		const coordinator = new GraphRefreshCoordinator({ debounceMs: 10, createGraph: () => new InMemorySymbolGraph(), scheduler });
		let runs = 0;
		coordinator.schedule("workspace-a", () => {
			runs += 1;
		});
		coordinator.schedule("workspace-a", () => {
			runs += 10;
		});

		scheduler.flush();
		expect(runs).toBe(10);
	});

	it("releaseWorkspaceIfIdle closes and forgets one workspace's graph handle, reporting whether one existed", async () => {
		let closes = 0;
		const coordinator = new GraphRefreshCoordinator({
			debounceMs: 10,
			createGraph: () => {
				const graph = new InMemorySymbolGraph();
				const close = graph.close.bind(graph);
				graph.close = async () => {
					closes += 1;
					await close();
				};
				return graph;
			},
		});
		const graph = coordinator.graph("workspace-a");

		expect(await coordinator.releaseWorkspaceIfIdle("workspace-a")).toBe(true);
		expect(closes).toBe(1);
		expect(coordinator.graph("workspace-a")).not.toBe(graph); // a fresh handle, not the released one

		expect(await coordinator.releaseWorkspaceIfIdle("never-touched")).toBe(false);
	});

	it("releaseWorkspaceIfIdle throws GraphRefreshJobActive and closes nothing while a job is running", async () => {
		const coordinator = new GraphRefreshCoordinator({ debounceMs: 10, createGraph: () => new InMemorySymbolGraph() });
		coordinator.graph("workspace-a");
		coordinator.setActiveJob("workspace-a", "job-1");

		await expect(coordinator.releaseWorkspaceIfIdle("workspace-a")).rejects.toBeInstanceOf(GraphRefreshJobActive);
	});

	it("releaseWorkspaceIfIdle cancels a pending debounced refresh so it cannot fire after release", async () => {
		const scheduler = new RecordingScheduler();
		const coordinator = new GraphRefreshCoordinator({ debounceMs: 10, createGraph: () => new InMemorySymbolGraph(), scheduler });
		let ran = false;
		coordinator.schedule("workspace-a", () => {
			ran = true;
		});

		await coordinator.releaseWorkspaceIfIdle("workspace-a");
		scheduler.flush();

		expect(ran).toBe(false);
	});
});
