import { posix } from "node:path";
import type { ContentHash } from "./content-hash.ts";

/** A single relative import/export specifier's exact text position, byte-offset into its file's own content -- no quotes, e.g. "./math" not "\"./math\"". */
export interface ImportSpecifierOccurrence {
	readonly specifier: string;
	readonly startIndex: number;
	readonly endIndex: number;
}

export interface ReferencingFileInput {
	readonly path: string;
	readonly content: string;
	readonly hash: ContentHash;
	readonly importSpecifiers: readonly ImportSpecifierOccurrence[];
}

export interface ReferenceBasedRenameInput {
	readonly fromPath: string;
	readonly toPath: string;
	readonly movedFileContent: string;
	readonly movedFileHash: ContentHash;
	readonly referencingFiles: readonly ReferencingFileInput[];
}

export interface FileMove {
	readonly fromPath: string;
	readonly toPath: string;
	readonly expectedHash: ContentHash;
	readonly content: string;
}

export interface ImportSpecifierRewrite {
	readonly path: string;
	readonly expectedHash: ContentHash;
	readonly newContent: string;
	readonly rewrittenSpecifiers: number;
}

export interface ReferenceBasedRenamePlan {
	readonly move: FileMove;
	readonly importRewrites: readonly ImportSpecifierRewrite[];
	readonly caveats: readonly string[];
}

/** Always surfaced, never silently omitted -- this rename's own explicit, known-narrower-than-LSP scope. */
const CAVEATS: readonly string[] = [
	"only rewrites static import/export declarations with a literal relative specifier -- dynamic import(expr)/require(expr) with a non-literal argument, and any plain string reference, are never touched",
	"scoped to references the workspace's own populated symbol graph already knows about -- a reference in an unindexed or excluded file is not covered",
];

const KNOWN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

function toPosixPath(path: string): string {
	return path.split("\\").join("/");
}

function stripKnownExtension(path: string): string {
	const posixPath = toPosixPath(path);
	for (const extension of KNOWN_EXTENSIONS) {
		if (posixPath.endsWith(extension)) return posixPath.slice(0, -extension.length);
	}
	return posixPath;
}

/** True only for a relative specifier ("./x", "../x") that resolves to the exact same file as targetAbsolutePath, ignoring a possibly-missing/differing known extension on either side. Never true for a bare package specifier -- resolving one of those requires real module resolution (node_modules, package.json "exports"), not path arithmetic, and a bare specifier can never point at a file this rename moved anyway. */
function resolvesToTarget(referencingFileDir: string, specifier: string, targetAbsolutePath: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const resolved = posix.resolve(toPosixPath(referencingFileDir), specifier);
	return stripKnownExtension(resolved) === stripKnownExtension(toPosixPath(targetAbsolutePath));
}

/**
 * The new specifier text (no quotes), preserving the ORIGINAL specifier's own extension
 * convention verbatim -- e.g. a ".js" specifier importing ".ts" source (a common bundler/Node-
 * ESM convention) stays ".js" after the rename, it is never replaced with the moved file's own
 * real on-disk extension. Extensionless stays extensionless. Always a "./"/"../"-prefixed
 * relative path.
 */
function computeNewSpecifier(referencingFileDir: string, originalSpecifier: string, newTargetAbsolutePath: string): string {
	const originalExtension = KNOWN_EXTENSIONS.find((extension) => originalSpecifier.endsWith(extension));
	const targetWithoutExtension = stripKnownExtension(newTargetAbsolutePath);
	const relative = posix.relative(toPosixPath(referencingFileDir), targetWithoutExtension);
	const withDot = relative.startsWith(".") ? relative : `./${relative}`;
	return originalExtension ? `${withDot}${originalExtension}` : withDot;
}

export function planReferenceBasedRename(input: ReferenceBasedRenameInput): ReferenceBasedRenamePlan {
	const importRewrites: ImportSpecifierRewrite[] = [];

	for (const file of input.referencingFiles) {
		const referencingDir = posix.dirname(toPosixPath(file.path));
		const matching = file.importSpecifiers.filter((occurrence) => resolvesToTarget(referencingDir, occurrence.specifier, input.fromPath));
		if (matching.length === 0) continue;

		// Rewrite from the end of the file backwards, so an earlier replacement's length change
		// never shifts the byte offsets of occurrences still waiting to be rewritten.
		const ordered = [...matching].sort((a, b) => b.startIndex - a.startIndex);
		let newContent = file.content;
		for (const occurrence of ordered) {
			const replacement = computeNewSpecifier(referencingDir, occurrence.specifier, input.toPath);
			newContent = newContent.slice(0, occurrence.startIndex) + replacement + newContent.slice(occurrence.endIndex);
		}

		importRewrites.push({ path: file.path, expectedHash: file.hash, newContent, rewrittenSpecifiers: matching.length });
	}

	return {
		move: { fromPath: input.fromPath, toPath: input.toPath, expectedHash: input.movedFileHash, content: input.movedFileContent },
		importRewrites,
		caveats: CAVEATS,
	};
}
