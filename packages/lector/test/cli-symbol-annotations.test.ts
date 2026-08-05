/**
 * End-to-end CLI parity for the annotation commands, against a real spawned
 * daemon and a real LSP-populated symbol graph -- proves the CLI's flag
 * parsing, the daemon's operation dispatch, and the service's anchor
 * resolution all agree, not just that each layer typechecks in isolation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/vehicle-server/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { DocumentSymbolEntry, SymbolAnnotation } from "../src/index.ts";
import { InMemoryWorkspace } from "../src/workspace/in-memory-workspace.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let daemon: RunningDaemon | undefined;
let fixtureRoot: string | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
	isolated?.cleanup();
	isolated = undefined;
});

function fixture(): string {
	fixtureRoot = mkdtempSync(join(tmpdir(), "lector-cli-annotation-"));
	writeFileSync(join(fixtureRoot, "index.ts"), "export function add() {\n\treturn 1;\n}\n");
	writeFileSync(join(fixtureRoot, "tsconfig.json"), "{}");
	return fixtureRoot;
}

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

/**
 * Registers the fixture, populates its symbol graph, and returns the exact
 * (line, character) populateSymbolGraph itself recorded for "add" -- fetched
 * via workspace.documentSymbols, the same underlying LSP call
 * populateSymbolGraph walks to build the graph in the first place.
 * workspace.findSymbols can report a subtly different column for the same
 * symbol (a different LSP capability), which would derive a different,
 * non-matching SymbolNodeId -- a real discovery, not a test artifact.
 */
async function registerAndPopulate(): Promise<{ workspaceId: string; path: string; line: number; character: number }> {
	const project = fixture();
	const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
	await runCli(["workspace", "populate-symbol-graph", registered.workspaceId, "--max-files", "10", "--max-symbols-per-file", "10", "--json"]);
	const path = join(project, "index.ts");
	const found = JSON.parse(await runCli(["workspace", "document-symbols", registered.workspaceId, path, "--json"])) as { symbols: DocumentSymbolEntry[] };
	const symbol = found.symbols.find((s) => s.name === "add");
	if (!symbol) throw new Error("fixture symbol 'add' was not found by workspace.documentSymbols");
	// populateSymbolGraph derives a node's SymbolNodeId from selectionRange.start specifically -- see symbol-graph/populate-symbol-graph.ts's toNodeLocation.
	return { workspaceId: registered.workspaceId, path, line: symbol.selectionRange.start.line, character: symbol.selectionRange.start.character };
}

describe("lector CLI annotation commands", () => {
	it("creates, gets, lists, refreshes, scrubs, and restores an annotation end-to-end against a real daemon", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const { workspaceId, path, line, character } = await registerAndPopulate();
		const anchor = `${path}:${line}:${character}`;

		const created = JSON.parse(
			await runCli([
				"workspace",
				"annotation",
				"create",
				workspaceId,
				"--subtype",
				"user-story-dataflow",
				"--title",
				"add flow",
				"--body",
				"explains the addition",
				"--anchor",
				anchor,
				"--json",
			]),
		) as SymbolAnnotation;
		expect(created.status).toBe("fresh");
		expect(created.anchors).toHaveLength(1);

		const fetched = JSON.parse(await runCli(["workspace", "annotation", "get", workspaceId, created.id, "--json"])) as SymbolAnnotation;
		expect(fetched.status).toBe("fresh");
		expect(fetched.title).toBe("add flow");

		const listed = JSON.parse(await runCli(["workspace", "annotation", "list", workspaceId, "--json"])) as SymbolAnnotation[];
		expect(listed.map((a) => a.id)).toContain(created.id);

		const refreshed = JSON.parse(
			await runCli([
				"workspace",
				"annotation",
				"refresh",
				workspaceId,
				created.id,
				"--subtype",
				"user-story-dataflow",
				"--title",
				"add flow",
				"--body",
				"updated narrative",
				"--anchor",
				anchor,
				"--json",
			]),
		) as SymbolAnnotation;
		expect(refreshed.body).toBe("updated narrative");
		expect(refreshed.status).toBe("fresh");

		const scrubbed = JSON.parse(await runCli(["workspace", "annotation", "scrub", workspaceId, created.id, "--json"])) as { scrubbed: boolean };
		expect(scrubbed.scrubbed).toBe(true);
		const listedAfterScrub = JSON.parse(await runCli(["workspace", "annotation", "list", workspaceId, "--json"])) as SymbolAnnotation[];
		expect(listedAfterScrub.map((a) => a.id)).not.toContain(created.id);

		const restored = JSON.parse(await runCli(["workspace", "annotation", "restore", workspaceId, created.id, "--json"])) as { restored: boolean };
		expect(restored.restored).toBe(true);
	}, 30_000);

	it("annotation list --query filters by title/body against a real daemon", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const { workspaceId, path, line, character } = await registerAndPopulate();
		const anchor = `${path}:${line}:${character}`;

		await runCli([
			"workspace",
			"annotation",
			"create",
			workspaceId,
			"--subtype",
			"comment",
			"--title",
			"addition dataflow",
			"--body",
			"explains how add() combines its inputs",
			"--anchor",
			anchor,
			"--json",
		]);
		await runCli([
			"workspace",
			"annotation",
			"create",
			workspaceId,
			"--subtype",
			"comment",
			"--title",
			"unrelated note",
			"--body",
			"nothing to do with it",
			"--anchor",
			anchor,
			"--json",
		]);

		const listed = JSON.parse(await runCli(["workspace", "annotation", "list", workspaceId, "--query", "dataflow", "--json"])) as SymbolAnnotation[];

		expect(listed.map((a) => a.title)).toEqual(["addition dataflow"]);
	}, 30_000);

	it("accepts a workspace-relative --anchor path, resolving to the same symbol as the absolute form", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const { workspaceId, path, line, character } = await registerAndPopulate();

		const createdViaAbsolute = JSON.parse(
			await runCli([
				"workspace",
				"annotation",
				"create",
				workspaceId,
				"--subtype",
				"note",
				"--title",
				"absolute",
				"--body",
				"b",
				"--anchor",
				`${path}:${line}:${character}`,
				"--json",
			]),
		) as SymbolAnnotation;

		const createdViaRelative = JSON.parse(
			await runCli([
				"workspace",
				"annotation",
				"create",
				workspaceId,
				"--subtype",
				"note",
				"--title",
				"relative",
				"--body",
				"b",
				"--anchor",
				`index.ts:${line}:${character}`,
				"--json",
			]),
		) as SymbolAnnotation;

		expect(createdViaRelative.status).toBe("fresh");
		expect(createdViaRelative.anchors[0]?.path).toBe(createdViaAbsolute.anchors[0]?.path);
		expect(createdViaRelative.anchors[0]?.symbolNodeId).toBe(createdViaAbsolute.anchors[0]?.symbolNodeId);
	}, 30_000);

	it("rejects an --anchor that does not resolve to any known symbol, with a non-zero exit", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const project = fixture();
		const registered = JSON.parse(await runCli(["workspace", "register", project, "--json"])) as { workspaceId: string };
		await runCli(["workspace", "populate-symbol-graph", registered.workspaceId, "--max-files", "10", "--max-symbols-per-file", "10", "--json"]);

		await expect(
			runCli([
				"workspace",
				"annotation",
				"create",
				registered.workspaceId,
				"--subtype",
				"comment",
				"--title",
				"t",
				"--body",
				"b",
				"--anchor",
				`${join(project, "index.ts")}:999:1`,
				"--json",
			]),
		).rejects.toThrow();
	}, 30_000);

	it("contains, reads via tree, and uncontains an annotation end-to-end against a real daemon", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const { workspaceId, path, line, character } = await registerAndPopulate();
		const anchor = `${path}:${line}:${character}`;

		const flow = JSON.parse(
			await runCli(["workspace", "annotation", "create", workspaceId, "--subtype", "comment", "--title", "flow", "--body", "b", "--anchor", anchor, "--json"]),
		) as SymbolAnnotation;
		const step = JSON.parse(
			await runCli(["workspace", "annotation", "create", workspaceId, "--subtype", "comment", "--title", "step", "--body", "b", "--anchor", anchor, "--json"]),
		) as SymbolAnnotation;

		const contained = JSON.parse(await runCli(["workspace", "annotation", "contain", workspaceId, flow.id, step.id, "--json"])) as { contained: boolean };
		expect(contained.contained).toBe(true);

		const tree = JSON.parse(await runCli(["workspace", "annotation", "tree", workspaceId, flow.id, "--max-depth", "5", "--json"])) as SymbolAnnotation[];
		expect(tree.map((a) => a.id).sort()).toEqual([flow.id, step.id].sort());

		const uncontained = JSON.parse(await runCli(["workspace", "annotation", "uncontain", workspaceId, flow.id, step.id, "--json"])) as {
			uncontained: boolean;
		};
		expect(uncontained.uncontained).toBe(true);

		const treeAfterUncontain = JSON.parse(
			await runCli(["workspace", "annotation", "tree", workspaceId, flow.id, "--max-depth", "5", "--json"]),
		) as SymbolAnnotation[];
		expect(treeAfterUncontain.map((a) => a.id)).toEqual([flow.id]);
	}, 30_000);

	it("rejects a containment cycle via the CLI, with a non-zero exit", async () => {
		isolated = isolatedLectorPaths();
		daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths: isolated.paths });
		const { workspaceId, path, line, character } = await registerAndPopulate();
		const anchor = `${path}:${line}:${character}`;

		const a = JSON.parse(
			await runCli(["workspace", "annotation", "create", workspaceId, "--subtype", "comment", "--title", "a", "--body", "b", "--anchor", anchor, "--json"]),
		) as SymbolAnnotation;
		const b = JSON.parse(
			await runCli(["workspace", "annotation", "create", workspaceId, "--subtype", "comment", "--title", "b", "--body", "b", "--anchor", anchor, "--json"]),
		) as SymbolAnnotation;
		await runCli(["workspace", "annotation", "contain", workspaceId, a.id, b.id, "--json"]);

		await expect(runCli(["workspace", "annotation", "contain", workspaceId, b.id, a.id, "--json"])).rejects.toThrow();
	}, 30_000);
});
