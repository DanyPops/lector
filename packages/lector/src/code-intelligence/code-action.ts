import type { ParsedWorkspaceEdit } from "../workspace/workspace-edit.ts";
import type { Diagnostic } from "./diagnostic.ts";

export class CodeActionsUnavailable extends Error {
	constructor(readonly backend: string) {
		super(`code-intelligence backend ${backend} does not support code actions`);
		this.name = "CodeActionsUnavailable";
	}
}

export interface CodeActionCommand {
	readonly title: string;
	readonly command: string;
	readonly arguments?: readonly unknown[];
}

/** One language-server code action normalized for preview and guarded application. */
export interface SemanticCodeAction {
	readonly path: string;
	readonly title: string;
	readonly kind?: string;
	readonly preferred: boolean;
	readonly disabledReason?: string;
	readonly diagnostics: readonly Diagnostic[];
	readonly edit?: ParsedWorkspaceEdit;
	readonly command?: CodeActionCommand;
	/** Opaque server data echoed only to codeAction/resolve. */
	readonly data?: unknown;
}

export type CodeActionPreviewId = string & { readonly __brand: "CodeActionPreviewId" };

export function codeActionPreviewId(value: string): CodeActionPreviewId {
	// This smart constructor is the sole boundary that mints the opaque preview-id brand.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as CodeActionPreviewId;
}

export interface CodeActionPreview {
	readonly id: CodeActionPreviewId;
	readonly title: string;
	readonly kind?: string;
	readonly preferred: boolean;
	readonly disabledReason?: string;
	readonly affectedPaths: readonly string[];
	readonly edit?: ParsedWorkspaceEdit;
	readonly command?: { readonly title: string; readonly command: string };
}

export interface CodeActionQuery {
	readonly path: string;
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
	readonly diagnostics: readonly Diagnostic[];
	readonly only?: readonly string[];
	readonly maxActions: number;
	readonly timeoutMs: number;
}
