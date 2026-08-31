import { describe, expect, it } from "bun:test";
import {
	IndexedSearchQueryBypass,
	type IndexedTextEngine,
	type IndexedTextEngineFactory,
	IndexedTextSearch,
} from "../../src/text-search/indexed-text-search.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "../../src/text-search/port.ts";

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
	let resolvePromise: () => void = () => {};
	let rejectPromise: (error: Error) => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const OPTIONS: TextSearchOptions = { maxMatches: 10, maxBytes: 10_000 };

class FixtureFallback implements TextSearchPort {
	async search(_rootPath: string, query: string, _options: TextSearchOptions) {
		return {
			matches: [{ path: "fallback.ts", lineNumber: 1, line: query, matchStart: 0, matchEnd: query.length }],
			truncated: false,
		};
	}
	async findFiles(_rootPath: string, _patterns: readonly string[], _options: FindFilesOptions) {
		return { paths: ["fallback.ts"], truncated: false };
	}
}

class FixtureEngine implements IndexedTextEngine {
	state: "missing" | "stale" | "fresh" = "missing";
	builds = 0;
	buildGate = deferred();

	async status() {
		return { state: this.state, indexedFiles: this.state === "fresh" ? 1 : 0, indexSizeBytes: this.state === "fresh" ? 100 : 0 } as const;
	}
	async build(_signal: AbortSignal): Promise<void> {
		this.builds += 1;
		await this.buildGate.promise;
		this.state = "fresh";
	}
	async search(_query: string, _options: TextSearchOptions) {
		return { matches: [{ path: "indexed.ts", lineNumber: 1, line: "indexed", matchStart: 0, matchEnd: 7 }], truncated: false };
	}
}

class FixtureFactory implements IndexedTextEngineFactory {
	readonly engines = new Map<string, FixtureEngine>();
	readonly buildOrder: string[] = [];
	open(rootPath: string): FixtureEngine {
		let engine = this.engines.get(rootPath);
		if (!engine) {
			engine = new FixtureEngine();
			const build = engine.build.bind(engine);
			engine.build = async (signal) => {
				this.buildOrder.push(rootPath);
				await build(signal);
			};
			this.engines.set(rootPath, engine);
		}
		return engine;
	}
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

describe("IndexedTextSearch", () => {
	it("falls back while a missing resident index builds, then uses it with explicit provenance", async () => {
		const factory = new FixtureFactory();
		const search = new IndexedTextSearch(new FixtureFallback(), factory, { maxConcurrentBuilds: 1, maxQueuedBuilds: 4, maxTrackedWorkspaces: 8 });
		search.registerWorkspace("/local", "local");

		const loading = await search.search("/local", "needle", OPTIONS);
		expect(loading.matches[0]?.path).toBe("fallback.ts");
		expect(loading.provenance).toEqual({ kind: "lexical", backend: "ripgrep", indexState: "loading" });
		const engine = factory.engines.get("/local");
		expect(engine?.builds).toBe(1);
		engine?.buildGate.resolve();
		await settle();

		const ready = await search.search("/local", "needle", OPTIONS);
		expect(ready.matches[0]?.path).toBe("indexed.ts");
		expect(ready.provenance).toEqual({ kind: "lexical", backend: "fff", indexState: "ready", indexedFiles: 1, indexSizeBytes: 100 });
	});

	it("marks watcher-invalidated indexes stale and keeps fresh fallback results during rebuild", async () => {
		const factory = new FixtureFactory();
		const engine = factory.open("/local");
		engine.state = "fresh";
		const search = new IndexedTextSearch(new FixtureFallback(), factory, { maxConcurrentBuilds: 1, maxQueuedBuilds: 4, maxTrackedWorkspaces: 8 });
		search.registerWorkspace("/local", "local");
		expect((await search.search("/local", "needle", OPTIONS)).provenance?.backend).toBe("fff");

		engine.buildGate = deferred();
		search.invalidate("/local");
		const stale = await search.search("/local", "needle", OPTIONS);
		expect(stale.matches[0]?.path).toBe("fallback.ts");
		expect(stale.provenance).toEqual({ kind: "lexical", backend: "ripgrep", indexState: "stale" });
	});

	it("bypasses the index honestly for a ripgrep-compatible query the indexed adapter cannot represent", async () => {
		const factory = new FixtureFactory();
		const engine = factory.open("/local");
		engine.state = "fresh";
		engine.search = async (query) => {
			throw new IndexedSearchQueryBypass(query);
		};
		const search = new IndexedTextSearch(new FixtureFallback(), factory, { maxConcurrentBuilds: 1, maxQueuedBuilds: 4, maxTrackedWorkspaces: 8 });
		search.registerWorkspace("/local", "local");
		const result = await search.search("/local", "(?P<word>needle)", OPTIONS);
		expect(result.matches[0]?.path).toBe("fallback.ts");
		expect(result.provenance).toEqual({ kind: "lexical", backend: "ripgrep", indexState: "bypassed" });
		expect(search.status("/local").state).toBe("ready");
	});

	it("reports degraded fallback when a build fails", async () => {
		const factory = new FixtureFactory();
		const search = new IndexedTextSearch(new FixtureFallback(), factory, { maxConcurrentBuilds: 1, maxQueuedBuilds: 4, maxTrackedWorkspaces: 8 });
		search.registerWorkspace("/local", "local");
		await search.search("/local", "needle", OPTIONS);
		factory.engines.get("/local")?.buildGate.reject(new Error("build failed"));
		await settle();
		const result = await search.search("/local", "needle", OPTIONS);
		expect(result.provenance).toEqual({ kind: "lexical", backend: "ripgrep", indexState: "degraded" });
	});

	it("evicts a tracked remote index rather than denying a local workspace", async () => {
		const factory = new FixtureFactory();
		const search = new IndexedTextSearch(new FixtureFallback(), factory, { maxConcurrentBuilds: 1, maxQueuedBuilds: 1, maxTrackedWorkspaces: 1 });
		search.registerWorkspace("/remote", "remote");
		await search.search("/remote", "needle", OPTIONS);
		search.registerWorkspace("/local", "local");
		expect(search.status("/remote").state).toBe("unavailable");
		expect(search.status("/local")).toEqual({ state: "unknown", origin: "local" });
	});

	it("schedules a local rebuild ahead of queued remote rebuilds", async () => {
		const factory = new FixtureFactory();
		const search = new IndexedTextSearch(new FixtureFallback(), factory, { maxConcurrentBuilds: 1, maxQueuedBuilds: 4, maxTrackedWorkspaces: 8 });
		search.registerWorkspace("/remote-a", "remote");
		search.registerWorkspace("/remote-b", "remote");
		search.registerWorkspace("/local", "local");
		await search.search("/remote-a", "needle", OPTIONS);
		await search.search("/remote-b", "needle", OPTIONS);
		await search.search("/local", "needle", OPTIONS);
		expect(factory.buildOrder).toEqual(["/remote-a"]);
		factory.engines.get("/remote-a")?.buildGate.resolve();
		await settle();
		expect(factory.buildOrder).toEqual(["/remote-a", "/local"]);
	});
});
