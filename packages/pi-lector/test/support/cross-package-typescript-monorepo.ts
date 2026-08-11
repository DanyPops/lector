import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A genuinely two-package monorepo -- unlike nested-typescript-monorepo.ts's fixture (whose
 * declaration and consumer sit in the SAME nested project, so it can't distinguish "the narrow
 * per-file project's own graph happened to be enough" from "the wider declared root's graph was
 * actually needed"), this one's consumer lives in a SEPARATE sibling package (its own
 * package.json, a real member of the root's declared "workspaces"), reaching into the library's
 * source via a relative import path that crosses the package boundary -- a real cross-package
 * reference the declaration's own narrow project can never see on its own, no matter how fresh
 * its own graph is. Deliberately a plain relative specifier (not a tsconfig "paths" mapping/bare
 * package name) -- Lector's own reference-based rename only rewrites a literal relative specifier
 * (see reference-based-rename.ts's own resolvesToTarget), so this is the shape that actually
 * exercises specifier rewriting, not just reference discovery.
 *
 * One ROOT tsconfig (not one per package) deliberately covers both packages' source in a single
 * flat TypeScript project -- real per-package project-reference/build-mode wiring is its own
 * separate concern orthogonal to what this fixture needs to prove; the monorepo MEMBERSHIP that
 * workspaceForDeclaredMonorepoRoot cares about comes entirely from each package's own package.json
 * plus the root's "workspaces" field, independent of tsserver's own project boundary.
 */
export interface CrossPackageTypeScriptMonorepoFixture {
	readonly root: string;
	readonly libraryRoot: string;
	readonly declarationFile: string;
	readonly consumerRoot: string;
	readonly consumerFile: string;
}

export function buildCrossPackageTypeScriptMonorepoFixture(prefix: string): CrossPackageTypeScriptMonorepoFixture {
	const root = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(root, ".git"));
	const libraryRoot = join(root, "packages", "library");
	const librarySrc = join(libraryRoot, "src");
	mkdirSync(librarySrc, { recursive: true });
	const declarationFile = join(librarySrc, "math.ts");
	writeFileSync(declarationFile, "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(libraryRoot, "package.json"), JSON.stringify({ name: "fixture-library", private: true, type: "module" }));

	const consumerRoot = join(root, "packages", "consumer");
	const consumerSrc = join(consumerRoot, "src");
	mkdirSync(consumerSrc, { recursive: true });
	const consumerFile = join(consumerSrc, "index.ts");
	// Reaches across the package boundary via a plain relative path -- unusual in a real monorepo
	// (which would normally go through a package name/workspace symlink), but a real, valid,
	// semantically-resolvable cross-package reference that also happens to be the one shape this
	// rename tool actually rewrites.
	writeFileSync(consumerFile, 'import { add } from "../../library/src/math";\n\nadd(1, 2);\n');
	writeFileSync(join(consumerRoot, "package.json"), JSON.stringify({ name: "fixture-consumer", private: true, type: "module" }));

	// One flat project spanning both packages' src directories -- see this file's own doc comment.
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true },
			include: ["packages/library/src", "packages/consumer/src"],
		}),
	);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-monorepo", private: true, workspaces: ["packages/*"] }));

	return { root, libraryRoot, declarationFile, consumerRoot, consumerFile };
}
