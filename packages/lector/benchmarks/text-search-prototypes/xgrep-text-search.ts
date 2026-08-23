/**
 * A prototype TextSearchPort backed by xgrep (napi-rs, trigram-indexed, disk-persisted). Not
 * production code -- exists to be measured against RipgrepTextSearch by the indexed-lexical-
 * search benchmark before any decision to adopt an indexed backend for real. Kept behind the
 * same port RipgrepTextSearch implements so both are exercised identically by the benchmark.
 *
 * Index lifetime is the caller's responsibility (buildIndex()/refreshIndex()) -- unlike
 * RipgrepTextSearch, a fresh scan every call is exactly the cost model this prototype exists to
 * measure against.
 */
import { Xgrep } from "xgrep";
import type { FindFilesResult } from "../../src/text-search/find-files-result.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "../../src/text-search/port.ts";
import type { TextSearchMatch, TextSearchResult } from "../../src/text-search/text-search-result.ts";

export class XgrepTextSearch implements TextSearchPort {
	private readonly engines = new Map<string, Xgrep>();

	private engineFor(rootPath: string): Xgrep {
		let engine = this.engines.get(rootPath);
		if (!engine) {
			engine = Xgrep.openLocal(rootPath);
			this.engines.set(rootPath, engine);
		}
		return engine;
	}

	/** Builds (or rebuilds) the on-disk trigram index for `rootPath` -- the cost this prototype exists to measure separately from warm search latency. */
	buildIndex(rootPath: string): void {
		this.engineFor(rootPath).buildIndex();
	}

	indexSizeBytes(rootPath: string): number {
		return this.engineFor(rootPath).indexStatus().indexSizeBytes;
	}

	async search(rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult> {
		const engine = this.engineFor(rootPath);
		const raw = engine.search(query, { maxCount: options.maxMatches });
		const matches: TextSearchMatch[] = [];
		let bytesUsed = 0;
		let truncated = false;
		for (const item of raw) {
			const bytes = Buffer.byteLength(item.line, "utf8");
			if (bytesUsed + bytes > options.maxBytes) {
				truncated = true;
				continue;
			}
			const matchStart = item.line.toLowerCase().indexOf(query.toLowerCase());
			matches.push({
				path: item.file,
				lineNumber: item.lineNumber,
				line: item.line,
				matchStart: Math.max(0, matchStart),
				matchEnd: Math.max(0, matchStart) + query.length,
			});
			bytesUsed += bytes;
			if (matches.length >= options.maxMatches) {
				truncated = truncated || raw.length > matches.length;
				break;
			}
		}
		return { matches, truncated };
	}

	async findFiles(rootPath: string, patterns: readonly string[], options: FindFilesOptions): Promise<FindFilesResult> {
		// xgrep's own napi surface (Xgrep.search) is content-search only -- file discovery is a
		// separate CLI mode (`xg --find`) not exposed through the native binding used here.
		// Honest gap, not silently faked: the benchmark measures search()/buildIndex() only.
		throw new Error("XgrepTextSearch.findFiles is not implemented in this prototype -- xgrep's file-discovery mode is CLI-only, not exposed via the napi binding");
	}
}
