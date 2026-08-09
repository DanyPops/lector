import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WarmIndexResourcePressure, WarmIndexResourceSnapshot, WarmIndexResourceSnapshotPort } from "./warm-index-resource-policy.ts";

export interface ResourceTextFilePort {
	readText(path: string): string;
}

export interface CgroupV2MemoryPaths {
	readonly current: string;
	readonly high: string;
	readonly max: string;
	readonly events: string;
	readonly pressure: string;
}

export interface CgroupV2DiscoveryOptions {
	readonly procSelfCgroupPath?: string;
	readonly cgroupRoot?: string;
}

export interface LinuxCgroupWarmIndexResourceOptions extends CgroupV2DiscoveryOptions {
	readonly files?: ResourceTextFilePort;
	readonly paths?: CgroupV2MemoryPaths;
	readonly explicitIndexMemoryBudgetBytes?: number;
	readonly recoveryStabilizationMs?: number;
	readonly now?: () => number;
}

const NODE_RESOURCE_FILES: ResourceTextFilePort = {
	readText: (path) => readFileSync(path, "utf8"),
};

const PRESSURE_RANK: Readonly<Record<WarmIndexResourcePressure, number>> = Object.freeze({
	low: 0,
	moderate: 1,
	high: 2,
	critical: 3,
});

const DEFAULT_RECOVERY_STABILIZATION_MS = 30_000;

function parseNonNegativeInteger(raw: string, field: string): number {
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must contain a non-negative safe integer`);
	return value;
}

function parseLimit(raw: string, field: string): number | undefined {
	if (raw.trim() === "max") return undefined;
	return parseNonNegativeInteger(raw, field);
}

function parseFlatCounters(raw: string): Readonly<Record<string, number>> {
	const counters: Record<string, number> = {};
	for (const line of raw.trim().split("\n")) {
		const [name, value] = line.trim().split(/\s+/, 2);
		if (name && value !== undefined) counters[name] = parseNonNegativeInteger(value, `memory.events.${name}`);
	}
	return counters;
}

function parsePressureAvg10(raw: string): { readonly some: number; readonly full: number } {
	let some = 0;
	let full = 0;
	for (const line of raw.trim().split("\n")) {
		const [kind, ...fields] = line.trim().split(/\s+/);
		const avg = fields.find((field) => field.startsWith("avg10="));
		if (!avg) continue;
		const value = Number(avg.slice("avg10=".length));
		if (!Number.isFinite(value) || value < 0) throw new TypeError(`memory.pressure ${kind ?? "unknown"} avg10 must be non-negative`);
		if (kind === "some") some = value;
		else if (kind === "full") full = value;
	}
	return { some, full };
}

function eventIncreased(previous: Readonly<Record<string, number>>, current: Readonly<Record<string, number>>, names: readonly string[]): boolean {
	return names.some((name) => (current[name] ?? 0) > (previous[name] ?? 0));
}

function classifyPressure(input: {
	readonly current: number;
	readonly high?: number;
	readonly max?: number;
	readonly previousEvents: Readonly<Record<string, number>>;
	readonly events: Readonly<Record<string, number>>;
	readonly psi: { readonly some: number; readonly full: number };
}): WarmIndexResourcePressure {
	if (eventIncreased(input.previousEvents, input.events, ["max", "oom", "oom_kill"])) return "critical";
	if (input.max !== undefined && input.max > 0 && input.current / input.max >= 0.95) return "critical";
	if (eventIncreased(input.previousEvents, input.events, ["high"]) || (input.high !== undefined && input.current >= input.high) || input.psi.full > 0) {
		return "high";
	}
	if ((input.high !== undefined && input.high > 0 && input.current / input.high >= 0.9) || input.psi.some > 0) return "moderate";
	return "low";
}

export function discoverCgroupV2MemoryPaths(
	files: ResourceTextFilePort = NODE_RESOURCE_FILES,
	options: CgroupV2DiscoveryOptions = {},
): CgroupV2MemoryPaths | undefined {
	const procSelfCgroupPath = options.procSelfCgroupPath ?? "/proc/self/cgroup";
	const cgroupRoot = resolve(options.cgroupRoot ?? "/sys/fs/cgroup");
	let membership: string;
	try {
		membership = files.readText(procSelfCgroupPath);
	} catch {
		return undefined;
	}
	const unified = membership
		.trim()
		.split("\n")
		.map((line) => line.split(":", 3))
		.find(([hierarchy, controllers, path]) => hierarchy === "0" && controllers === "" && path !== undefined);
	const cgroupPath = unified?.[2];
	if (!cgroupPath || !isAbsolute(cgroupPath)) return undefined;
	const directory = resolve(cgroupRoot, cgroupPath.slice(1));
	const relativeDirectory = relative(cgroupRoot, directory);
	if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativeDirectory)) {
		return undefined;
	}
	return {
		current: join(directory, "memory.current"),
		high: join(directory, "memory.high"),
		max: join(directory, "memory.max"),
		events: join(directory, "memory.events"),
		pressure: join(directory, "memory.pressure"),
	};
}

class ExplicitWarmIndexResources implements WarmIndexResourceSnapshotPort {
	constructor(private readonly budget: number) {}
	current(): WarmIndexResourceSnapshot {
		return { indexMemoryBudgetBytes: this.budget, pressure: "low" };
	}
}

class LinuxCgroupWarmIndexResources implements WarmIndexResourceSnapshotPort {
	private previousEvents: Readonly<Record<string, number>>;
	private pressureState: WarmIndexResourcePressure = "low";
	private recoveryStartedAt: number | undefined;

	constructor(
		private readonly files: ResourceTextFilePort,
		private readonly paths: CgroupV2MemoryPaths,
		private readonly baselineMemoryBytes: number,
		private readonly explicitBudgetBytes: number | undefined,
		private readonly recoveryStabilizationMs: number,
		private readonly now: () => number,
	) {
		this.previousEvents = parseFlatCounters(files.readText(paths.events));
	}

	private stabilize(candidate: WarmIndexResourcePressure): WarmIndexResourcePressure {
		const currentRank = PRESSURE_RANK[this.pressureState];
		const candidateRank = PRESSURE_RANK[candidate];
		if (candidateRank >= currentRank) {
			this.pressureState = candidate;
			this.recoveryStartedAt = undefined;
			return candidate;
		}
		const now = this.now();
		this.recoveryStartedAt ??= now;
		if (now - this.recoveryStartedAt >= this.recoveryStabilizationMs) {
			this.pressureState = candidate;
			this.recoveryStartedAt = undefined;
		}
		return this.pressureState;
	}

	current(): WarmIndexResourceSnapshot {
		try {
			const current = parseNonNegativeInteger(this.files.readText(this.paths.current), "memory.current");
			const high = parseLimit(this.files.readText(this.paths.high), "memory.high");
			const max = parseLimit(this.files.readText(this.paths.max), "memory.max");
			const events = parseFlatCounters(this.files.readText(this.paths.events));
			const psi = parsePressureAvg10(this.files.readText(this.paths.pressure));
			const candidate = classifyPressure({ current, high, max, previousEvents: this.previousEvents, events, psi });
			this.previousEvents = events;
			const budget = this.explicitBudgetBytes ?? Math.max(0, (high ?? 0) - this.baselineMemoryBytes);
			return { indexMemoryBudgetBytes: budget, pressure: this.stabilize(candidate) };
		} catch {
			this.pressureState = "critical";
			this.recoveryStartedAt = undefined;
			return { indexMemoryBudgetBytes: 0, pressure: "critical" };
		}
	}
}

export function createLinuxCgroupWarmIndexResourceSnapshot(options: LinuxCgroupWarmIndexResourceOptions = {}): WarmIndexResourceSnapshotPort | undefined {
	const explicitBudget = options.explicitIndexMemoryBudgetBytes;
	if (explicitBudget !== undefined && (!Number.isSafeInteger(explicitBudget) || explicitBudget < 1)) {
		throw new TypeError("explicitIndexMemoryBudgetBytes must be a positive safe integer");
	}
	const recoveryStabilizationMs = options.recoveryStabilizationMs ?? DEFAULT_RECOVERY_STABILIZATION_MS;
	if (!Number.isSafeInteger(recoveryStabilizationMs) || recoveryStabilizationMs < 0) {
		throw new TypeError("recoveryStabilizationMs must be a non-negative safe integer");
	}
	const files = options.files ?? NODE_RESOURCE_FILES;
	const paths = options.paths ?? discoverCgroupV2MemoryPaths(files, options);
	if (!paths) return explicitBudget === undefined ? undefined : new ExplicitWarmIndexResources(explicitBudget);
	try {
		const baselineMemoryBytes = parseNonNegativeInteger(files.readText(paths.current), "memory.current");
		const high = parseLimit(files.readText(paths.high), "memory.high");
		if (explicitBudget === undefined && high === undefined) return undefined;
		return new LinuxCgroupWarmIndexResources(files, paths, baselineMemoryBytes, explicitBudget, recoveryStabilizationMs, options.now ?? Date.now);
	} catch {
		return explicitBudget === undefined ? undefined : new ExplicitWarmIndexResources(explicitBudget);
	}
}
