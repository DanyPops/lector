import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import type { SymbolNode } from "../symbol-graph/port.ts";
import type { WorkspacePort } from "./port.ts";
import { supportsSourceSnapshot } from "./source-snapshot.ts";

/** Validates localization evidence against at most 128 files and 16 MiB of current source. */
export class LocalizationSources {
	private readonly files = new Map<string, string | undefined>();
	private bytes = 0;
	partial = false;

	constructor(
		private readonly workspace: WorkspacePort,
		private readonly hashes: Readonly<Record<string, ContentHash>> | undefined,
		private readonly signal: AbortSignal,
	) {}

	private async content(path: string): Promise<string | undefined> {
		if (this.files.has(path)) return this.files.get(path);
		if (this.signal.aborted || this.files.size >= 128 || this.bytes >= 16_777_216 || !supportsSourceSnapshot(this.workspace)) {
			this.partial = true;
			return undefined;
		}
		this.files.set(path, undefined);
		try {
			const allowance = Math.min(1_048_576, 16_777_216 - this.bytes);
			this.bytes += allowance;
			const snapshot = await this.workspace.readSourceSnapshot(path, allowance, this.signal);
			if (snapshot.status !== "ready" || Buffer.byteLength(snapshot.content) > allowance) {
				this.partial = true;
				return undefined;
			}
			this.bytes -= allowance - Buffer.byteLength(snapshot.content);
			this.files.set(path, snapshot.content);
			return snapshot.content;
		} catch {
			this.partial = true;
			return undefined;
		}
	}

	private line(content: string, line: number): string | undefined {
		if (!Number.isSafeInteger(line) || line < 1) return undefined;
		let start = 0;
		for (let current = 1; current < line; current++) {
			const newline = content.indexOf("\n", start);
			if (newline < 0) return undefined;
			start = newline + 1;
		}
		const end = content.indexOf("\n", start);
		return content.slice(start, end < 0 ? undefined : end).trim();
	}

	async declaration(node: SymbolNode): Promise<string | undefined> {
		const hash = this.hashes?.[node.location.path];
		if (!hash) {
			this.partial = true;
			return undefined;
		}
		const content = await this.content(node.location.path);
		if (content === undefined || contentHashOf(content) !== hash) {
			this.partial = true;
			return undefined;
		}
		const line = this.line(content, node.location.line);
		if (!line) this.partial = true;
		return line;
	}

	async lexical(path: string, line: number, expected: string): Promise<boolean> {
		const content = await this.content(path);
		const valid = content !== undefined && this.line(content, line) === expected.trim();
		if (!valid) this.partial = true;
		return valid;
	}
}
