import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLectorClientAt } from "../src/client.ts";
import { resolveLectorPaths } from "../src/constants.ts";
import { startLectorDaemon } from "../src/daemon.ts";

let root: string | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function buildFixture(): string {
	const fixture = mkdtempSync(join(tmpdir(), "lector-sequential-renames-"));
	mkdirSync(join(fixture, "src"));
	mkdirSync(join(fixture, "domain"));
	mkdirSync(join(fixture, "core"));
	writeFileSync(join(fixture, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(fixture, "src", "consumer.ts"), 'import { add } from "./math";\n\nexport function sum(): number {\n\treturn add(1, 2);\n}\n');
	writeFileSync(join(fixture, "core", "existing.ts"), "export const existing = true;\n");
	writeFileSync(
		join(fixture, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src", "domain", "core"] }),
	);
	return fixture;
}

describe("sequential reference-based rename daemon liveness", () => {
	it("keeps one daemon and workspace usable across successful and failed cross-directory renames", async () => {
		root = buildFixture();
		const paths = resolveLectorPaths({
			env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
		});
		const daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths });
		stop = () => daemon.stop();
		const token = readFileSync(paths.token, "utf8").trim();
		const client = connectLectorClientAt(`http://${daemon.host}:${daemon.port}`, token);
		const { workspaceId } = await client.call("workspace.registerPath", { path: root });
		const bounds = { maxFiles: 20, maxSymbolsPerFile: 20 };
		await client.call("workspace.populateSymbolGraph", { workspaceId, ...bounds });

		await client.call("workspace.referenceBasedRename", {
			workspaceId,
			fromPath: join(root, "src", "math.ts"),
			toPath: join(root, "domain", "arithmetic.ts"),
			...bounds,
		});
		await client.call("workspace.populateSymbolGraph", { workspaceId, ...bounds });
		await client.call("workspace.referenceBasedRename", {
			workspaceId,
			fromPath: join(root, "domain", "arithmetic.ts"),
			toPath: join(root, "core", "algebra.ts"),
			...bounds,
		});
		await client.call("workspace.populateSymbolGraph", { workspaceId, ...bounds });

		const failed = client.call("workspace.referenceBasedRename", {
			workspaceId,
			fromPath: join(root, "core", "algebra.ts"),
			toPath: join(root, "core", "existing.ts"),
			...bounds,
		});
		await expect(failed).rejects.toThrow();

		await expect(client.health()).resolves.toMatchObject({ ok: true });
		const symbols = await client.call("workspace.findSymbols", { workspaceId, seedFile: "core/algebra.ts", query: "add" });
		expect(symbols.symbols.some((symbol) => symbol.name === "add")).toBe(true);
		const references = await client.call("workspace.findReferences", {
			workspaceId,
			path: join(root, "core", "algebra.ts"),
			line: 1,
			character: 17,
			includeDeclaration: true,
		});
		expect(references.locations.some((location) => location.path.endsWith("consumer.ts"))).toBe(true);
		expect(readFileSync(join(root, "src", "consumer.ts"), "utf8")).toContain('from "../core/algebra"');
		expect(readFileSync(join(root, "core", "algebra.ts"), "utf8")).toContain("function add");
		expect(readFileSync(join(root, "core", "existing.ts"), "utf8")).toBe("export const existing = true;\n");
	}, 60_000);
});
