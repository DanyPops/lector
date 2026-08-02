import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assertSafeGlobPattern } from "../domain/assert-safe-glob-pattern.ts";
import { assertSafeSearchQuery } from "../domain/assert-safe-search-query.ts";
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
		let truncated = false;

		const rl = createInterface({ input: child.stdout });
		for await (const line of rl) {
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isMatchEvent(event)) continue;

			const lineText = event.data.lines.text;
			const submatch = event.data.submatches[0];
			matches.push({
				path: event.data.path.text.replace(/^\.\//, ""),
				lineNumber: event.data.line_number,
				line: lineText,
				matchStart: submatch?.start ?? 0,
				matchEnd: submatch?.end ?? 0,
			});
			bytesUsed += Buffer.byteLength(lineText, "utf8");

			if (matches.length >= options.maxMatches || bytesUsed >= options.maxBytes) {
				truncated = true;
				child.kill();
				break;
			}
		}
		rl.close();

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
