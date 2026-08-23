/**
 * A prototype TextSearchPort backed by Sourcegraph's zoekt (Go, trigram-indexed, disk-persisted
 * shards). Not production code -- exists to be measured against RipgrepTextSearch by the
 * indexed-lexical-search benchmark before any decision to adopt an indexed backend for real.
 *
 * Zoekt ships no npm package and no library binding usable from Bun/Node -- this prototype
 * shells out to the real `zoekt-index`/`zoekt` binaries (built via `go install
 * github.com/sourcegraph/zoekt/cmd/{zoekt-index,zoekt}@latest`), a materially heavier deployment
 * shape than xgrep/FFF's own in-process bindings. That deployment cost is itself one of the axes
 * this benchmark measures, not an implementation detail to hide.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { FindFilesResult } from "../../src/text-search/find-files-result.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "../../src/text-search/port.ts";
import type { TextSearchMatch, TextSearchResult } from "../../src/text-search/text-search-result.ts";

interface ZoektLineFragment {
	readonly LineOffset: number;
	readonly MatchLength: number;
}
interface ZoektLineMatch {
	readonly Line: string;
	readonly LineNumber: number;
	readonly LineFragments: readonly ZoektLineFragment[];
}
interface ZoektFileResult {
	readonly FileName: string;
	readonly LineMatches: readonly ZoektLineMatch[];
}

function runProcess(command: string, args: readonly string[]): Promise<{ stdout: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve({ stdout, code }));
	});
}

export class ZoektTextSearch implements TextSearchPort {
	constructor(
		private readonly indexDir: string,
		private readonly zoektIndexBin = "zoekt-index",
		private readonly zoektBin = "zoekt",
	) {}

	/** Runs zoekt-index against `rootPath`, writing shards into this instance's own indexDir -- the cost this prototype exists to measure separately from warm search latency. */
	async buildIndex(rootPath: string): Promise<void> {
		mkdirSync(this.indexDir, { recursive: true });
		const { code, stdout } = await runProcess(this.zoektIndexBin, ["-index", this.indexDir, rootPath]);
		if (code !== 0) throw new Error(`zoekt-index exited with code ${code}: ${stdout}`);
	}

	async search(_rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult> {
		const { code, stdout } = await runProcess(this.zoektBin, ["-index_dir", this.indexDir, "-jsonl", query]);
		if (code !== 0 && stdout.trim() === "") throw new Error(`zoekt exited with code ${code} and no output`);
		const matches: TextSearchMatch[] = [];
		let bytesUsed = 0;
		let truncated = false;
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			const parsed = JSON.parse(line) as ZoektFileResult;
			for (const lineMatch of parsed.LineMatches) {
				const decoded = Buffer.from(lineMatch.Line, "base64").toString("utf8");
				const bytes = Buffer.byteLength(decoded, "utf8");
				if (bytesUsed + bytes > options.maxBytes || matches.length >= options.maxMatches) {
					truncated = true;
					continue;
				}
				const fragment = lineMatch.LineFragments[0];
				matches.push({
					path: parsed.FileName,
					lineNumber: lineMatch.LineNumber,
					line: decoded,
					matchStart: fragment?.LineOffset ?? 0,
					matchEnd: (fragment?.LineOffset ?? 0) + (fragment?.MatchLength ?? 0),
				});
				bytesUsed += bytes;
			}
		}
		return { matches, truncated };
	}

	async findFiles(_rootPath: string, _patterns: readonly string[], _options: FindFilesOptions): Promise<FindFilesResult> {
		// zoekt is a content-search engine with a `file:` query filter, not a standalone file-listing
		// mode comparable to ripgrep --files/xg --find/fff glob -- honest gap, not silently faked.
		// The benchmark measures search()/buildIndex() only.
		throw new Error("ZoektTextSearch.findFiles is not implemented in this prototype -- zoekt has no standalone file-listing mode");
	}
}
