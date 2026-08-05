import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";
import { LANGUAGE_SERVER_DESCRIPTORS } from "../src/code-intelligence/language-server-descriptor.ts";

function packageName(modulePath: string): string {
	const [first, second] = modulePath.split("/");
	if (!first) throw new Error(`invalid module path: ${modulePath}`);
	return first.startsWith("@") ? `${first}/${second}` : first;
}

describe("published runtime dependencies", () => {
	it("ships every npm-launched language server as a production dependency", () => {
		const required = LANGUAGE_SERVER_DESCRIPTORS.flatMap((descriptor) =>
			descriptor.launch.kind === "npm-module" ? [packageName(descriptor.launch.entryModule)] : [],
		);
		for (const dependency of required) expect(packageJson.dependencies).toHaveProperty(dependency);
	});

	it("ships the TypeScript compiler used for tsconfig-aware project discovery", () => {
		expect(packageJson.dependencies).toHaveProperty("typescript");
	});

	it("ships every parser used for npm-family lockfile resolution", () => {
		for (const dependency of ["@yarnpkg/parsers", "jsonc-parser", "yaml"]) {
			expect(packageJson.dependencies).toHaveProperty(dependency);
		}
	});

	it("ships the bounded npm registry transport", () => {
		expect(packageJson.dependencies).toHaveProperty("fetch-retry");
	});
});
