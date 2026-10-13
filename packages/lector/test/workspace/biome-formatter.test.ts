import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { biomeFormatter } from "../../src/workspace/biome-formatter.ts";

it("configured Biome formats stdin without writing the original file", async () => {
	const directory = await mkdtemp("/tmp/opencode/biome-preview-");
	try {
		const path = join(directory, "input.json");
		const source = '{"value":1}';
		await writeFile(path, source);
		const formatter = biomeFormatter(resolve(import.meta.dir, "../../../../node_modules/.bin/biome"));
		const result = await formatter(path, source);
		expect(JSON.parse(result)).toEqual({ value: 1 });
		expect(result).not.toBe(source);
		expect(await readFile(path, "utf8")).toBe(source);
		await expect(formatter(path, "{broken")).rejects.toThrow();
		await expect(formatter(join(directory, "unsupported.go"), "package main")).rejects.toThrow("not configured");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("formatter configuration refuses relative executables", () => {
	expect(() => biomeFormatter("biome")).toThrow("absolute");
});
