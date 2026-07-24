import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

// Bun resolves the bare specifier "typescript" from a directly-executed .ts entrypoint to an
// unrelated global stub (`~/.cache/.bun/install/cache/typescript@<version>/lib/version.cjs`,
// ~2 exports, no `sys`/`findConfigFile`/etc) -- confirmed empirically, not assumed: `require`,
// `import`, and `import.meta.resolve` on the bare specifier all hit it, only a deep import path
// resolves the real, project-local package. This is a real, working typescript package once
// resolved this way, not the version that bun hijacks.
const ts = createRequire(import.meta.url)("typescript/lib/typescript.js") as typeof import("typescript");

/**
 * Refines a seed-file candidate against TypeScript's own real project-file resolution
 * (`findConfigFile` + `parseJsonConfigFileContent`, the same functions tsserver itself uses) --
 * a candidate merely sitting *under* a directory that has a tsconfig.json is not sufficient:
 * that tsconfig's own include/exclude may not actually cover it (found empirically against this
 * project's own monorepo: a seed file picked from `benchmarks/` had a real tsconfig.json two
 * directories up, but that tsconfig's `include: ["src", "test"]` never covered it, so
 * workspace/symbol silently searched the wrong, near-empty inferred project). Falls back to the
 * original candidate if no tsconfig is found at all, or parsing fails -- honest degradation to
 * the pre-refinement heuristic, not a hard failure.
 */
export function refineTypescriptSeedFile(rootPath: string, candidateRelativePath: string): string {
	try {
		// Searched from the candidate's own directory, not rootPath -- tsserver associates a file
		// with the nearest enclosing tsconfig to *that file*, which in a monorepo is almost always
		// several directories below the registered workspace root (e.g. packages/lector/tsconfig.json,
		// not a root tsconfig.json that may not even exist).
		const candidateDir = join(rootPath, dirname(candidateRelativePath));
		const configPath = ts.findConfigFile(candidateDir, ts.sys.fileExists);
		if (!configPath) return candidateRelativePath;

		const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
		if (error) return candidateRelativePath;

		// include/exclude are resolved relative to the config file's own directory, not rootPath.
		const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
		if (parsed.fileNames.length === 0) return candidateRelativePath;

		const candidateAbsolute = join(rootPath, candidateRelativePath);
		if (parsed.fileNames.includes(candidateAbsolute)) return candidateRelativePath;

		const firstRealFile = parsed.fileNames[0];
		if (!firstRealFile) return candidateRelativePath;
		const relativeToRoot = relative(rootPath, firstRealFile);
		if (relativeToRoot.startsWith("..")) return candidateRelativePath;
		return relativeToRoot;
	} catch {
		return candidateRelativePath;
	}
}
