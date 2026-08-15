import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstalledPackageVersionBounds, JavaScriptPackageManager } from "./installed-package-version.ts";
import { ManifestResourceLimitExceeded } from "./limits.ts";
import { evidence, isRecord, type ParsedEvidence, stringField } from "./parsers/shared.ts";

export type ManifestSyntax = "json" | "yaml";

const READ_CHUNK_BYTES = 64 * 1024;

function jsonNesting(text: string): number {
	let depth = 0;
	let maximum = 0;
	let quote: '"' | "'" | null = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index] ?? "";
		const next = text[index + 1] ?? "";
		if (lineComment) {
			if (character === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			index++;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index++;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "{" || character === "[") {
			depth++;
			maximum = Math.max(maximum, depth);
		} else if (character === "}" || character === "]") {
			depth = Math.max(0, depth - 1);
		}
	}
	return maximum;
}

function yamlNesting(text: string): number {
	const indentation: number[] = [];
	let maximum = 0;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const width = line.match(/^[ \t]*/)?.[0].replaceAll("\t", "  ").length ?? 0;
		while (indentation.length > 0 && width <= (indentation.at(-1) ?? 0)) indentation.pop();
		indentation.push(width);
		maximum = Math.max(maximum, indentation.length + jsonNesting(line));
	}
	return maximum;
}

/** Bounds every real filesystem read and every parser's own entry/workspace/diagnostic count against one caller-supplied budget, shared across every lockfile a single resolve() call reads. */
export class ResolutionContext {
	private bytesRead = 0;
	private entriesRead = 0;
	private diagnosticsRead = 0;
	private readonly workspaces = new Set<string>();
	private readonly root: string;
	readonly bounds: InstalledPackageVersionBounds;

	constructor(projectRoot: string, bounds: InstalledPackageVersionBounds) {
		this.root = realpathSync(resolve(projectRoot));
		this.bounds = bounds;
	}

	touchEntry(): void {
		this.entriesRead++;
		if (this.entriesRead > this.bounds.maxManifestEntries) throw new ManifestResourceLimitExceeded("manifest-entries");
	}

	reportDiagnostics(count: number): void {
		this.diagnosticsRead += count;
		if (this.diagnosticsRead > this.bounds.maxDiagnostics) throw new ManifestResourceLimitExceeded("diagnostics");
	}

	touchWorkspace(workspacePath: string): void {
		const normalized = workspacePath === "" ? "." : workspacePath.replaceAll("\\", "/");
		if (this.workspaces.has(normalized)) return;
		this.workspaces.add(normalized);
		if (this.workspaces.size > this.bounds.maxWorkspaces) throw new ManifestResourceLimitExceeded("workspaces");
	}

	private projectPath(relativePath: string): string {
		if (isAbsolute(relativePath)) throw new Error("manifest path is absolute");
		const absolutePath = resolve(this.root, relativePath);
		const relativePathFromRoot = relative(this.root, absolutePath);
		if (relativePathFromRoot === ".." || relativePathFromRoot.startsWith(`..${sep}`) || isAbsolute(relativePathFromRoot)) {
			throw new Error("manifest path escapes project root");
		}
		if (!existsSync(absolutePath)) return absolutePath;
		const realPath = realpathSync(absolutePath);
		const realPathFromRoot = relative(this.root, realPath);
		if (realPathFromRoot === ".." || realPathFromRoot.startsWith(`..${sep}`) || isAbsolute(realPathFromRoot)) {
			throw new Error("manifest symlink escapes project root");
		}
		return realPath;
	}

	readProjectFile(relativePath: string, syntax: ManifestSyntax): string {
		const descriptor = openSync(this.projectPath(relativePath), "r");
		try {
			const stat = fstatSync(descriptor);
			if (!stat.isFile()) throw new Error("manifest is not a regular file");
			const remaining = this.bounds.maxManifestBytes - this.bytesRead;
			if (stat.size > remaining) throw new ManifestResourceLimitExceeded("manifest-bytes");
			const chunks: Buffer[] = [];
			let total = 0;
			let bytesRead: number;
			do {
				const capacity = Math.min(READ_CHUNK_BYTES, remaining - total + 1);
				const chunk = Buffer.allocUnsafe(capacity);
				bytesRead = readSync(descriptor, chunk, 0, capacity, null);
				total += bytesRead;
				if (total > remaining) throw new ManifestResourceLimitExceeded("manifest-bytes");
				if (bytesRead > 0) chunks.push(chunk.subarray(0, bytesRead));
			} while (bytesRead > 0);
			this.bytesRead += total;
			const text = Buffer.concat(chunks, total).toString("utf8");
			const nesting = syntax === "json" ? jsonNesting(text) : yamlNesting(text);
			if (nesting > this.bounds.maxManifestNesting) throw new ManifestResourceLimitExceeded("manifest-nesting");
			return text;
		} finally {
			closeSync(descriptor);
		}
	}

	workspaceVersion(workspacePath: string, packageName: string, lockfile: string, manager: JavaScriptPackageManager): ParsedEvidence | null {
		this.touchWorkspace(workspacePath);
		const normalized = workspacePath === "." || workspacePath === "" ? "package.json" : join(workspacePath, "package.json");
		const manifestPath = this.projectPath(normalized);
		if (!existsSync(manifestPath)) return null;
		const text = this.readProjectFile(normalized, "json");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.reportDiagnostics(1);
			throw new Error("invalid workspace package manifest");
		}
		this.touchEntry();
		if (!isRecord(parsed) || stringField(parsed, "name") !== packageName) return null;
		const version = stringField(parsed, "version");
		if (version === null) return null;
		return { version, evidence: evidence(manager, lockfile, workspacePath, null, true) };
	}
}
