import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { SymbolSearchResult } from "../src/workspace/workspace-symbol.ts";
import { findPositionOf } from "./support/find-position.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "./support/typescript-reference-fixture.ts";

let daemon: RunningDaemon | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;
let fixture: TypeScriptReferenceFixture | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	isolated?.cleanup();
	isolated = undefined;
	fixture?.dispose();
	fixture = undefined;
});

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: {
			...process.env,
			XDG_DATA_HOME: isolated.root,
			XDG_STATE_HOME: isolated.root,
			XDG_RUNTIME_DIR: isolated.root,
			XDG_CONFIG_HOME: isolated.root,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

describe("TypeScript/JavaScript reference CLI parity", () => {
	it("previews and applies a guarded code action", async () => {
		isolated = isolatedLectorPaths();
		fixture = materializeTypeScriptReferenceFixture();
		const actionPath = join(fixture.root, "packages/app/src/code-action.ts");
		writeFileSync(actionPath, "export function load(): void {\n\tawait Promise.resolve();\n}\n");
		daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", fixture.root, "--json"])) as { workspaceId: string };
		const preview = JSON.parse(
			await runCli([
				"workspace",
				"code-actions",
				"preview",
				registration.workspaceId,
				actionPath,
				"2",
				"2",
				"2",
				"7",
				"--only",
				"quickfix",
				"--max-actions",
				"10",
				"--max-edits",
				"100",
				"--max-files",
				"10",
				"--max-bytes",
				"100000",
				"--deadline-ms",
				"10000",
				"--json",
			]),
		) as { actions: Array<{ id: string; title: string }> };
		const action = preview.actions.find(({ title }) => /async/i.test(title));
		expect(action).toBeDefined();
		if (!action) throw new Error("expected async quick fix");
		const applied = JSON.parse(await runCli(["workspace", "code-actions", "apply", registration.workspaceId, action.id, "--json"])) as {
			touchedPaths: string[];
			transactionId?: string;
		};
		expect(applied.touchedPaths).toEqual([actionPath]);
		expect(applied.transactionId).toBeDefined();
		expect(readFileSync(actionPath, "utf8")).toContain("export async function load");
	}, 30_000);
	it("preserves bounded semantic provenance in JSON and human output", async () => {
		isolated = isolatedLectorPaths();
		fixture = materializeTypeScriptReferenceFixture();
		daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", fixture.root, "--json"])) as { workspaceId: string };

		const json = JSON.parse(await runCli(["workspace", "symbols", registration.workspaceId, "runCheckout", "--json"])) as SymbolSearchResult;
		expect(json.provenance).toMatchObject({ fidelity: "semantic", backend: "typescript-language-server", authority: "language-server" });
		expect(json.symbols.some(({ name }) => name === "runCheckout")).toBe(true);
		expect(typeof json.truncated).toBe("boolean");

		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		const usage = findPositionOf(checkoutPath, "processor.process(order)");
		const definition = JSON.parse(
			await runCli([
				"workspace",
				"definition",
				registration.workspaceId,
				checkoutPath,
				String(usage.line),
				String(usage.character + "processor.".length),
				"--json",
			]),
		) as { provenance: SymbolSearchResult["provenance"]; locations: readonly { path: string }[] };
		expect(definition.provenance).toEqual(json.provenance);
		expect(definition.locations.some(({ path }) => path.endsWith("packages/contracts/src/payment.ts"))).toBe(true);

		const human = await runCli(["workspace", "symbols", registration.workspaceId, "runCheckout"]);
		expect(human).toContain("semantic via typescript-language-server");
		expect(human).toContain("runCheckout");
		expect(human.length).toBeLessThan(20_000);
	}, 30_000);

	it("returns bounded changed-symbol impact with related-test evidence", async () => {
		isolated = isolatedLectorPaths();
		fixture = materializeTypeScriptReferenceFixture();
		execFileSync("git", ["init", "-q"], { cwd: fixture.root });
		execFileSync("git", ["config", "user.email", "fixture@lector.invalid"], { cwd: fixture.root });
		execFileSync("git", ["config", "user.name", "Lector Fixture"], { cwd: fixture.root });
		execFileSync("git", ["add", "-A"], { cwd: fixture.root });
		execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: fixture.root });
		daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", fixture.root, "--json"])) as { workspaceId: string };
		await runCli(["workspace", "populate-symbol-graph", registration.workspaceId, "--max-files", "100", "--max-symbols-per-file", "100", "--json"]);
		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		writeFileSync(checkoutPath, (await Bun.file(checkoutPath).text()).replace("return processor.process(order);", "return await processor.process(order);"));
		const result = JSON.parse(
			await runCli([
				"workspace",
				"impact",
				registration.workspaceId,
				"--ref",
				"HEAD",
				"--max-depth",
				"2",
				"--max-nodes",
				"500",
				"--max-edges",
				"5000",
				"--max-bytes",
				"100000",
				"--deadline-ms",
				"20000",
				"--max-files",
				"100",
				"--max-symbols-per-file",
				"100",
				"--auto-populate",
				"--json",
			]),
		) as { changedSymbols: readonly unknown[]; relatedTests: readonly { evidence: { kind: string } }[]; truncated: boolean };
		expect(result.changedSymbols.length).toBeGreaterThan(0);
		expect(result.relatedTests.every(({ evidence }) => evidence.kind === "semantic-edge" || evidence.kind === "filename-heuristic")).toBe(true);
		expect(typeof result.truncated).toBe("boolean");
		const delta = JSON.parse(
			await runCli([
				"workspace",
				"diagnostic-delta",
				registration.workspaceId,
				"git",
				"HEAD",
				"--max-results",
				"100",
				"--max-bytes",
				"100000",
				"--max-depth",
				"2",
				"--max-nodes",
				"500",
				"--max-edges",
				"5000",
				"--deadline-ms",
				"30000",
				"--max-files",
				"100",
				"--max-symbols-per-file",
				"100",
				"--auto-populate",
				"--json",
			]),
		) as { source: { kind: string; ref: string }; completeness: string };
		expect(delta.source).toEqual({ kind: "git", ref: "HEAD" });
		expect(delta.completeness).toBe("complete");
	}, 45_000);

	it("routes bounded type-hierarchy queries and preserves capability-unavailable", async () => {
		isolated = isolatedLectorPaths();
		fixture = materializeTypeScriptReferenceFixture();
		daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", fixture.root, "--json"])) as { workspaceId: string };
		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		const declaration = findPositionOf(checkoutPath, "export async function runCheckout");

		await expect(
			runCli([
				"workspace",
				"type-hierarchy",
				"prepare",
				registration.workspaceId,
				checkoutPath,
				String(declaration.line),
				String(declaration.character + "export async function ".length),
				"--max-results",
				"10",
				"--max-bytes",
				"10000",
				"--deadline-ms",
				"10000",
				"--json",
			]),
		).rejects.toThrow("does not support type hierarchy");
	}, 30_000);

	it("preserves polyglot source provenance in JSON and human output", async () => {
		isolated = isolatedLectorPaths();
		fixture = materializeTypeScriptReferenceFixture();
		writeFileSync(join(fixture.root, "polyglot.ts"), "export function polyglotTypeScript(): void {}\n");
		writeFileSync(join(fixture.root, "polyglot.py"), "def polyglot_python() -> None:\n    pass\n");
		writeFileSync(join(fixture.root, "go.mod"), "module fixture/polyglot\n\ngo 1.22\n");
		writeFileSync(join(fixture.root, "polyglot.go"), "package polyglot\n\nfunc PolyglotGo() {}\n");
		daemon = await startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", fixture.root, "--json"])) as { workspaceId: string };

		const json = JSON.parse(await runCli(["workspace", "symbols", registration.workspaceId, "polyglot", "--json"])) as SymbolSearchResult;
		expect(json.provenance).toMatchObject({ backend: "polyglot-language-servers", languageId: "polyglot" });
		expect(json.sources?.map((source) => source.provenance.languageId)).toEqual(["typescript", "python", "go"]);
		expect(json.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["polyglotTypeScript", "polyglot_python", "PolyglotGo"]));

		const human = await runCli(["workspace", "symbols", registration.workspaceId, "polyglot"]);
		expect(human).toContain("typescript: ready via typescript-language-server");
		expect(human).toContain("python: ready via pyright");
		expect(human).toContain("go: ready via gopls");
	}, 30_000);
});
