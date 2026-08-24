import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { InstalledGoModuleVersionBounds } from "./installed-go-module.ts";
import { ManifestResourceLimitExceeded } from "./limits.ts";

const READ_CHUNK_BYTES = 64 * 1024;

/** Bounds every real filesystem read and every parser's own entry/diagnostic count against one caller-supplied budget, shared across every manifest a single resolve() call reads. */
export class GoResolutionContext {
	private bytesRead = 0;
	private entriesRead = 0;
	private diagnosticsRead = 0;
	private workspaceModulesRead = 0;
	private readonly root: string;
	readonly bounds: InstalledGoModuleVersionBounds;

	constructor(projectRoot: string, bounds: InstalledGoModuleVersionBounds) {
		this.root = realpathSync(resolve(projectRoot));
		this.bounds = bounds;
	}

	touchEntry(): void {
		this.entriesRead++;
		if (this.entriesRead > this.bounds.maxManifestEntries) throw new ManifestResourceLimitExceeded("manifest-entries");
	}

	touchWorkspaceModule(): void {
		this.workspaceModulesRead++;
		if (this.workspaceModulesRead > this.bounds.maxWorkspaceModules) throw new ManifestResourceLimitExceeded("workspace-modules");
	}

	reportDiagnostics(count: number): void {
		this.diagnosticsRead += count;
		if (this.diagnosticsRead > this.bounds.maxDiagnostics) throw new ManifestResourceLimitExceeded("diagnostics");
	}

	private projectPath(relativePath: string): string {
		if (isAbsolute(relativePath)) throw new Error("manifest path is absolute");
		const absolutePath = resolve(this.root, relativePath);
		const relativeFromRoot = relative(this.root, absolutePath);
		if (relativeFromRoot === ".." || relativeFromRoot.startsWith(`..${sep}`) || isAbsolute(relativeFromRoot)) {
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

	/** True only when the path resolves to a real, existing, in-bounds file -- callers use this to decide whether a given manifest is even present before attempting to read it. */
	hasProjectFile(relativePath: string): boolean {
		try {
			return existsSync(this.projectPath(relativePath));
		} catch {
			return false;
		}
	}

	readProjectFile(relativePath: string): string {
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
			return Buffer.concat(chunks, total).toString("utf8");
		} finally {
			closeSync(descriptor);
		}
	}
}
