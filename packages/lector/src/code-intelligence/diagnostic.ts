import type { CodeRange } from "../workspace/code-range.ts";

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** One issue a language server reports against a specific range of a file, as of its last analysis. */
export interface Diagnostic {
	readonly range: CodeRange;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
}

/** Distinguishes the same real issue reported twice (once via push, once via pull) from two genuinely different diagnostics. */
function diagnosticKey(diagnostic: Diagnostic): string {
	return JSON.stringify([diagnostic.range, diagnostic.severity, diagnostic.message, diagnostic.source ?? null, diagnostic.code ?? null]);
}

/**
 * Merges push-delivered (textDocument/publishDiagnostics) and pull-delivered
 * (textDocument/diagnostic) results for one file into one deduplicated list.
 * A server may support both models at once, or a session may hold stale push
 * diagnostics from before a pull became available -- the same real issue must
 * appear once, not twice. `pull` wins ties: it is the fresher, request/response-
 * confirmed source when both report an identical issue.
 */
export function mergeDiagnostics(push: readonly Diagnostic[], pull: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const merged: Diagnostic[] = [];
	for (const diagnostic of [...pull, ...push]) {
		const key = diagnosticKey(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(diagnostic);
	}
	return merged;
}
