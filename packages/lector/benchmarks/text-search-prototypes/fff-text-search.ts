/**
 * A prototype TextSearchPort backed by @ff-labs/fff-bun (Rust core, Bun-native FFI, in-memory
 * resident index with a background filesystem watcher). Not production code -- exists to be
 * measured against RipgrepTextSearch by the indexed-lexical-search benchmark before any decision
 * to adopt an indexed backend for real.
 *
 * Unlike xgrep's on-disk index, FFF's index lives in the process's own memory for the finder
 * instance's lifetime, kept fresh by a background watcher rather than an explicit rebuild step --
 * a materially different cost/freshness tradeoff the benchmark measures directly (memory
 * resident the whole time vs. disk-persisted but requiring an explicit rebuild).
 */
import { FileFinder } from "@ff-labs/fff-bun";
import type { FindFilesResult } from "../../src/text-search/find-files-result.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "../../src/text-search/port.ts";
import type { TextSearchMatch, TextSearchResult } from "../../src/text-search/text-search-result.ts";

export class FffTextSearch implements TextSearchPort {
	private readonly finders = new Map<string, FileFinder>();

	/** Opens (or reuses) a resident finder for `rootPath` and waits for its initial scan -- the cost this prototype exists to measure separately from warm search latency. */
	async openAndScan(rootPath: string, timeoutMs: number): Promise<void> {
		if (this.finders.has(rootPath)) return;
		const created = FileFinder.create({ basePath: rootPath, aiMode: true });
		if (!created.ok) throw new Error(`FFF FileFinder.create failed: ${created.error}`);
		const finder = created.value;
		const scanned = await finder.waitForScan(timeoutMs);
		if (!scanned.ok || !scanned.value) throw new Error(`FFF initial scan did not complete within ${timeoutMs}ms`);
		this.finders.set(rootPath, finder);
	}

	destroyAll(): void {
		for (const finder of this.finders.values()) finder.destroy();
		this.finders.clear();
	}

	private finderFor(rootPath: string): FileFinder {
		const finder = this.finders.get(rootPath);
		if (!finder) throw new Error(`FffTextSearch.openAndScan(${rootPath}) must complete before search()/findFiles()`);
		return finder;
	}

	async search(rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult> {
		const finder = this.finderFor(rootPath);
		const result = finder.grep(query, { pageSize: options.maxMatches, mode: "plain" });
		if (!result.ok) throw new Error(`FFF grep failed: ${result.error}`);
		const matches: TextSearchMatch[] = [];
		let bytesUsed = 0;
		let truncated = result.value.nextCursor !== null;
		for (const item of result.value.items) {
			const bytes = Buffer.byteLength(item.lineContent, "utf8");
			if (bytesUsed + bytes > options.maxBytes) {
				truncated = true;
				continue;
			}
			const [matchStart, matchEnd] = item.matchRanges[0] ?? [0, 0];
			matches.push({ path: item.relativePath, lineNumber: item.lineNumber, line: item.lineContent, matchStart, matchEnd });
			bytesUsed += bytes;
		}
		return { matches, truncated };
	}

	async findFiles(rootPath: string, patterns: readonly string[], options: FindFilesOptions): Promise<FindFilesResult> {
		const finder = this.finderFor(rootPath);
		const paths: string[] = [];
		let bytesUsed = 0;
		let truncated = false;
		for (const pattern of patterns) {
			const result = finder.glob(pattern, { pageSize: options.maxResults });
			if (!result.ok) throw new Error(`FFF glob failed: ${result.error}`);
			for (const item of result.value.items) {
				const bytes = Buffer.byteLength(item.relativePath, "utf8");
				if (bytesUsed + bytes > options.maxBytes || paths.length >= options.maxResults) {
					truncated = true;
					continue;
				}
				paths.push(item.relativePath);
				bytesUsed += bytes;
			}
		}
		return { paths, truncated };
	}
}
