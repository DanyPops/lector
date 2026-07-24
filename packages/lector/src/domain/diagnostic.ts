import type { CodeRange } from "./code-range.ts";

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** One issue a language server reports against a specific range of a file, as of its last analysis. */
export interface Diagnostic {
	readonly range: CodeRange;
	readonly severity: DiagnosticSeverity;
	readonly message: string;
	readonly source?: string;
	readonly code?: string | number;
}
