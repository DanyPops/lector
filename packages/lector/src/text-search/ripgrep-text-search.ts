import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assertSafeGlobPattern } from "./assert-safe-glob-pattern.ts";
import { assertSafeSearchQuery } from "./assert-safe-search-query.ts";
import type { FindFilesResult } from "./find-files-result.ts";
import type { FindFilesOptions, TextSearchOptions, TextSearchPort } from "./port.ts";
import { SKIP_DIRECTORY_NAMES } from "./skip-directories.ts";
import type { TextSearchMatch, TextSearchResult } from "./text-search-result.ts";

// ripgrep only skips a directory automatically when a real .gitignore names it -- verified
// empirically (a fixture with no .gitignore let a bare `rg` search node_modules freely).
// Explicit globs make the same bound findSourceFiles already enforces hold here too, regardless
// of whether the target repo's own .gitignore happens to list these directories.
const EXCLUDE_GLOBS = Array.from(SKIP_DIRECTORY_NAMES, (name) => ["--glob", `!${name}/`]).flat();

interface RipgrepMatchEvent {
	readonly type: "match";
	readonly data: {
		readonly path: { readonly text: string };
		readonly lines: { readonly text: string };
		readonly line_number: number;
		readonly submatches: readonly { readonly start: number; readonly end: number }[];
	};
}

function isMatchEvent(value: unknown): value is RipgrepMatchEvent {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "match";
}

const MAX_MATCH_LINE_BYTES = 16 * 1024;

interface BoundedMatchLine {
	readonly line: string;
	readonly bytes: number;
	readonly matchStart: number;
	readonly matchEnd: number;
	readonly lineTruncated: boolean;
	readonly lineStartByte: number;
}

/** Keeps the first matched span inside a UTF-8-safe excerpt instead of blindly retaining a giant line prefix that may not contain the match. */
export function boundMatchLine(line: string, matchStart: number, matchEnd: number, maxBytes: number): BoundedMatchLine {
	const encoded = Buffer.from(line, "utf8");
	if (encoded.byteLength <= maxBytes) {
		return { line, bytes: encoded.byteLength, matchStart, matchEnd, lineTruncated: false, lineStartByte: 0 };
	}

	const safeStart = Math.max(0, Math.min(matchStart, encoded.byteLength));
	const safeEnd = Math.max(safeStart, Math.min(matchEnd, encoded.byteLength));
	const matchBytes = safeEnd - safeStart;
	const contextBytes = Math.max(0, maxBytes - Math.min(matchBytes, maxBytes));
	let start = Math.max(0, safeStart - Math.floor(contextBytes / 2));
	let end = Math.min(encoded.byteLength, start + maxBytes);
	start = Math.max(0, end - maxBytes);

	// Both slice boundaries must begin at UTF-8 code-point boundaries. Moving the
	// start forward and end backward can only reduce the result below maxBytes.
	while (start < end && (encoded[start] ?? 0) >>> 6 === 2) start += 1;
	while (end > start && (encoded[end] ?? 0) >>> 6 === 2) end -= 1;

	const bounded = encoded.subarray(start, end);
	return {
		line: bounded.toString("utf8"),
		bytes: bounded.byteLength,
		matchStart: Math.max(0, safeStart - start),
		matchEnd: Math.min(bounded.byteLength, safeEnd - start),
		lineTruncated: true,
		lineStartByte: start,
	};
}

/**
 * TextSearchPort backed by real ripgrep (`rg --json`), streamed line-by-line via readline
 * rather than buffered wholesale (execFile's default maxBuffer would either truncate or throw
 * on a search producing megabytes of matches). The moment a bound is hit the child process is
 * killed outright, not just stopped-reading-from -- a search over a huge monorepo must not keep
 * scanning to completion just because this adapter already has enough matches.
 *
 * ripgrep already respects a real .gitignore and skips hidden/binary files by default, but a
 * repo with no .gitignore listing node_modules gets searched into it freely -- explicit
 * --glob exclusions (the same skip-list findSourceFiles uses) make that bound unconditional.
 */
export class RipgrepTextSearch implements TextSearchPort {
	async search(rootPath: string, query: string, options: TextSearchOptions): Promise<TextSearchResult> {
		assertSafeSearchQuery(query);
		// `--` marks the end of flags -- defense in depth beyond assertSafeSearchQuery, the same
		// two-layer approach local-git.ts already uses for git's diff ref.
		const child = spawn("rg", ["--json", ...EXCLUDE_GLOBS, "--", query], { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] });

		// Registered before draining stdout, not after: an 'exit' event fired while this adapter
		// was still reading matches would otherwise be missed entirely, hanging the process-exit
		// wait forever.
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
			child.once("error", reject);
		});

		const matches: TextSearchMatch[] = [];
		let bytesUsed = 0;
		let candidatesSeen = 0;
		let truncated = false;
		// When more than one result was requested, no single matched line may consume
		// more than half the aggregate line-text budget. The fixed ceiling prevents a
		// giant line from dominating even under a very generous aggregate budget.
		const maxMatchLineBytes = Math.max(1, Math.min(MAX_MATCH_LINE_BYTES, options.maxMatches > 1 ? Math.floor(options.maxBytes / 2) : options.maxBytes));
		// Continuing past a candidate that does not fit improves result quality, but
		// must not turn a bounded response into an unbounded ripgrep scan.
		const maxCandidates = Math.min(Number.MAX_SAFE_INTEGER, options.maxMatches * 4);
		const abort = () => {
			truncated = true;
			child.kill();
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });

		const rl = createInterface({ input: child.stdout });
		for await (const line of rl) {
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isMatchEvent(event)) continue;
			candidatesSeen += 1;

			const lineText = event.data.lines.text;
			const submatch = event.data.submatches[0];
			const boundedLine = boundMatchLine(lineText, submatch?.start ?? 0, submatch?.end ?? 0, maxMatchLineBytes);
			if (bytesUsed + boundedLine.bytes > options.maxBytes) {
				// Keep scanning: a later compact hit may still fit the remaining aggregate
				// budget even when this candidate does not.
				truncated = true;
				if (candidatesSeen >= maxCandidates) {
					child.kill();
					break;
				}
				continue;
			}
			matches.push({
				path: event.data.path.text.replace(/^\.\//, ""),
				lineNumber: event.data.line_number,
				line: boundedLine.line,
				...(boundedLine.lineTruncated ? { lineTruncated: true as const, lineStartByte: boundedLine.lineStartByte } : {}),
				matchStart: boundedLine.matchStart,
				matchEnd: boundedLine.matchEnd,
			});
			bytesUsed += boundedLine.bytes;

			if (matches.length >= options.maxMatches || bytesUsed >= options.maxBytes || candidatesSeen >= maxCandidates) {
				truncated = true;
				child.kill();
				break;
			}
		}
		rl.close();
		options.signal?.removeEventListener("abort", abort);

		const { code } = await exited;
		// rg's own exit codes: 0 = matches found, 1 = no matches, 2 = a real error (e.g. an
		// invalid regex). A kill this adapter itself issued is expected and never an error,
		// whatever exit code/signal it produced.
		if (!truncated && code !== 0 && code !== 1) {
			throw new Error(`rg exited with code ${code}`);
		}

		return { matches, truncated };
	}

	async findFiles(rootPath: string, patterns: readonly string[], options: FindFilesOptions): Promise<FindFilesResult> {
		for (const pattern of patterns) assertSafeGlobPattern(pattern);
		const globArgs = patterns.flatMap((pattern) => ["--glob", pattern]);
		// ripgrep's own --glob precedence is "last matching glob for a path wins", the same rule
		// .gitignore itself uses -- EXCLUDE_GLOBS must come AFTER the caller's own patterns, not
		// before, or a broad caller pattern like "*" silently re-includes node_modules/.git by
		// simply being listed later. Verified empirically: reversing this order let a caller-
		// supplied "*" defeat every exclusion.
		// `--` marks the end of flags -- defense in depth beyond assertSafeGlobPattern, mirroring search()'s own two-layer approach.
		const child = spawn("rg", ["--files", ...globArgs, ...EXCLUDE_GLOBS, "--"], { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"] });

		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
			child.once("error", reject);
		});

		const paths: string[] = [];
		let bytesUsed = 0;
		let truncated = false;

		const rl = createInterface({ input: child.stdout });
		for await (const line of rl) {
			if (!line) continue;
			const path = line.replace(/^\.\//, "");
			paths.push(path);
			bytesUsed += Buffer.byteLength(path, "utf8");

			if (paths.length >= options.maxResults || bytesUsed >= options.maxBytes) {
				truncated = true;
				child.kill();
				break;
			}
		}
		rl.close();

		const { code } = await exited;
		// rg --files' own exit codes: 0 = at least one file listed, 1 = zero files matched (not an
		// error, verified empirically), 2 = a real error (e.g. an invalid glob).
		if (!truncated && code !== 0 && code !== 1) {
			throw new Error(`rg exited with code ${code}`);
		}

		return { paths, truncated };
	}
}
