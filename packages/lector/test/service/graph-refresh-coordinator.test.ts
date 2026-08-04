import { describe, expect, it } from "bun:test";
import { GraphRefreshCoordinator } from "../../src/service/graph-refresh-coordinator.ts";
import { InMemorySymbolGraph } from "../../src/symbol-graph/in-memory-symbol-graph.ts";

class RecordingScheduler {
	readonly callbacks = new Map<string, () => void>();
	schedule(key: string, callback: () => void): void {
		this.callbacks.set(key, callback);
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
});
