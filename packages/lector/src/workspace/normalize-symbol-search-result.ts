import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SymbolSearchResult, WorkspaceSymbol } from "./workspace-symbol.ts";

// Backends disagree on this too: the LSP backend returns absolute paths (fileURLToPath of a
// real URI); the structural TypeScript-compiler/tree-sitter fallbacks return paths relative to
// their own rootPath. A bare path.relative() against a relative candidate resolves it against
// process.cwd() instead, not the workspace -- silently misclassifying every real in-root
// structural-fallback result as external. Resolve against the root first so both shapes compare
// the same way.
function isUnderRoot(rootPath: string, candidatePath: string): boolean {
	const absoluteCandidate = isAbsolute(candidatePath) ? candidatePath : resolve(rootPath, candidatePath);
	const relativePath = relative(rootPath, absoluteCandidate);
	return relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

function symbolIdentity(symbol: WorkspaceSymbol): string {
	return `${symbol.name}\u0000${symbol.kind}\u0000${symbol.location.path}\u0000${symbol.location.line}\u0000${symbol.location.character}`;
}

/**
 * Enforces find_symbols' own documented contract (case-insensitive substring name match,
 * workspace-root scope) on whatever a backend actually returned. Backends disagree on what
 * "matching" means -- tsserver's workspace/symbol is fuzzy, gopls' happily includes the module
 * cache and stdlib -- so without this, backend-specific semantics leak straight through the
 * public API instead of the one contract every caller was told to expect.
 */
export function normalizeSymbolSearchResult(result: SymbolSearchResult, query: string, workspaceRootPath: string, maxResults: number): SymbolSearchResult {
	const needle = query.toLowerCase();
	const seen = new Set<string>();
	const kept: WorkspaceSymbol[] = [];
	for (const symbol of result.symbols) {
		if (!symbol.name.toLowerCase().includes(needle)) continue;
		if (!isUnderRoot(workspaceRootPath, symbol.location.path)) continue;
		const identity = symbolIdentity(symbol);
		if (seen.has(identity)) continue;
		seen.add(identity);
		kept.push(symbol);
	}
	// The backend's own truncation is real signal (it may have cut off before we could even see a
	// true match); exceeding the caller's requested count after filtering is separately real
	// truncation. Filtering itself (an irrelevant fuzzy hit, an out-of-root path, a duplicate) is
	// not truncation -- it's this function doing its job, not evidence of a missing result.
	const truncated = result.truncated || kept.length > maxResults;
	return { ...result, symbols: kept.slice(0, maxResults), truncated };
}
