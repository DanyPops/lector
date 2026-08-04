import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NestedTypeScriptMonorepoFixture {
	readonly root: string;
	readonly packageRoot: string;
	readonly sourceDirectory: string;
	readonly declarationFile: string;
	readonly consumerFile: string;
}

export function buildNestedTypeScriptMonorepoFixture(prefix: string): NestedTypeScriptMonorepoFixture {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const packageRoot = join(root, "packages", "library");
	const sourceDirectory = join(packageRoot, "src", "domain");
	mkdirSync(join(root, ".git"));
	mkdirSync(sourceDirectory, { recursive: true });

	const declarationFile = join(sourceDirectory, "math.ts");
	writeFileSync(declarationFile, "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	const consumerFile = join(sourceDirectory, "consumer.ts");
	writeFileSync(consumerFile, 'import { add } from "./math";\n\nadd(1, 2);\n');
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-library", private: true, type: "module" }));
	writeFileSync(
		join(packageRoot, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-monorepo", private: true, workspaces: ["packages/*"] }));

	return { root, packageRoot, sourceDirectory, declarationFile, consumerFile };
}
