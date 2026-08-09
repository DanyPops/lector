import { describe, expect, it } from "bun:test";
import {
	createLinuxCgroupWarmIndexResourceSnapshot,
	discoverCgroupV2MemoryPaths,
	type ResourceTextFilePort,
} from "../../src/code-intelligence/linux-cgroup-warm-index-resources.ts";

class MutableResourceFiles implements ResourceTextFilePort {
	constructor(private readonly values = new Map<string, string>()) {}

	readText(path: string): string {
		const value = this.values.get(path);
		if (value === undefined) throw new Error(`missing fixture ${path}`);
		return value;
	}

	set(path: string, value: string): void {
		this.values.set(path, value);
	}

	delete(path: string): void {
		this.values.delete(path);
	}
}

const PATHS = {
	current: "/cgroup/memory.current",
	high: "/cgroup/memory.high",
	max: "/cgroup/memory.max",
	events: "/cgroup/memory.events",
	pressure: "/cgroup/memory.pressure",
} as const;

function resourceFiles(): MutableResourceFiles {
	return new MutableResourceFiles(
		new Map([
			[PATHS.current, "100\n"],
			[PATHS.high, "500\n"],
			[PATHS.max, "800\n"],
			[PATHS.events, "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n"],
			[PATHS.pressure, "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"],
		]),
	);
}

describe("discoverCgroupV2MemoryPaths", () => {
	it("resolves the process cgroup beneath the cgroup root", () => {
		const files = new MutableResourceFiles(new Map([["/proc/self/cgroup", "0::/user.slice/lector.service\n"]]));
		expect(discoverCgroupV2MemoryPaths(files, { procSelfCgroupPath: "/proc/self/cgroup", cgroupRoot: "/sys/fs/cgroup" })).toEqual({
			current: "/sys/fs/cgroup/user.slice/lector.service/memory.current",
			high: "/sys/fs/cgroup/user.slice/lector.service/memory.high",
			max: "/sys/fs/cgroup/user.slice/lector.service/memory.max",
			events: "/sys/fs/cgroup/user.slice/lector.service/memory.events",
			pressure: "/sys/fs/cgroup/user.slice/lector.service/memory.pressure",
		});
	});

	it("returns undefined for cgroup v1 or a malformed path", () => {
		const files = new MutableResourceFiles(new Map([["/proc/self/cgroup", "5:memory:/legacy\n"]]));
		expect(discoverCgroupV2MemoryPaths(files)).toBeUndefined();
		files.set("/proc/self/cgroup", "0::/../../escape\n");
		expect(discoverCgroupV2MemoryPaths(files)).toBeUndefined();
	});
});

describe("Linux cgroup warm-index resources", () => {
	it("turns a changing memory.high into a changing index budget", () => {
		const files = resourceFiles();
		const resources = createLinuxCgroupWarmIndexResourceSnapshot({ files, paths: PATHS });
		expect(resources?.current()).toEqual({ indexMemoryBudgetBytes: 400, pressure: "low" });

		files.set(PATHS.high, "700\n");
		expect(resources?.current()).toEqual({ indexMemoryBudgetBytes: 600, pressure: "low" });
		files.set(PATHS.high, "300\n");
		expect(resources?.current()).toEqual({ indexMemoryBudgetBytes: 200, pressure: "low" });
	});

	it("uses an explicit index budget even when memory.high is unlimited", () => {
		const files = resourceFiles();
		files.set(PATHS.high, "max\n");
		const resources = createLinuxCgroupWarmIndexResourceSnapshot({ files, paths: PATHS, explicitIndexMemoryBudgetBytes: 256 });
		expect(resources?.current()).toEqual({ indexMemoryBudgetBytes: 256, pressure: "low" });
	});

	it("falls back to fixed mode without an explicit budget or finite memory.high", () => {
		const files = resourceFiles();
		files.set(PATHS.high, "max\n");
		expect(createLinuxCgroupWarmIndexResourceSnapshot({ files, paths: PATHS })).toBeUndefined();
	});

	it("classifies cgroup events, utilization, and PSI without exposing raw files", () => {
		const files = resourceFiles();
		const resources = createLinuxCgroupWarmIndexResourceSnapshot({ files, paths: PATHS, recoveryStabilizationMs: 0 });
		expect(resources?.current().pressure).toBe("low");

		files.set(PATHS.current, "460\n");
		expect(resources?.current().pressure).toBe("moderate");
		files.set(PATHS.current, "500\n");
		expect(resources?.current().pressure).toBe("high");
		files.set(PATHS.current, "100\n");
		files.set(PATHS.pressure, "some avg10=2.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
		expect(resources?.current().pressure).toBe("moderate");
		files.set(PATHS.pressure, "some avg10=2.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.10 avg60=0.00 avg300=0.00 total=1\n");
		expect(resources?.current().pressure).toBe("high");
		files.set(PATHS.events, "low 0\nhigh 0\nmax 0\noom 1\noom_kill 0\n");
		expect(resources?.current().pressure).toBe("critical");
	});

	it("recovers from pressure only after a stabilization window", () => {
		let now = 0;
		const files = resourceFiles();
		const resources = createLinuxCgroupWarmIndexResourceSnapshot({ files, paths: PATHS, now: () => now, recoveryStabilizationMs: 100 });
		files.set(PATHS.events, "low 0\nhigh 1\nmax 0\noom 0\noom_kill 0\n");
		expect(resources?.current().pressure).toBe("high");
		files.set(PATHS.events, "low 0\nhigh 1\nmax 0\noom 0\noom_kill 0\n");

		now = 50;
		expect(resources?.current().pressure).toBe("high");
		now = 149;
		expect(resources?.current().pressure).toBe("high");
		now = 150;
		expect(resources?.current().pressure).toBe("low");
	});

	it("fails closed if cgroup metrics disappear after startup", () => {
		const files = resourceFiles();
		const resources = createLinuxCgroupWarmIndexResourceSnapshot({ files, paths: PATHS });
		files.delete(PATHS.current);
		expect(resources?.current()).toEqual({ indexMemoryBudgetBytes: 0, pressure: "critical" });
	});

	it("reads the current Linux cgroup through the production file adapter", () => {
		if (process.platform !== "linux") return;
		const resources = createLinuxCgroupWarmIndexResourceSnapshot({ explicitIndexMemoryBudgetBytes: 1024 });
		const snapshot = resources?.current();
		if (!snapshot) throw new Error("explicit Linux resource budget did not create a snapshot port");
		expect(snapshot.indexMemoryBudgetBytes).toBeGreaterThanOrEqual(0);
		expect(["low", "moderate", "high", "critical"]).toContain(snapshot.pressure);
	});
});
