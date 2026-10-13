import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIntelligencePort } from "../src/code-intelligence/port.ts";
import { contentHashOf } from "../src/content-identity/content-hash.ts";
import { type ClosableSymbolIndex, createLectorService, type LectorService } from "../src/service.ts";
import type { ParsedWorkspaceEdit } from "../src/workspace/workspace-edit.ts";

const roots: string[] = [];
const services: LectorService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const provenance = {
	fidelity: "semantic",
	backend: "fixture",
	languageId: "typescript",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
} as const;

async function fixture(formatted = false) {
	const root = mkdtempSync("/tmp/opencode/rename-preview-");
	roots.push(root);
	const sourcePath = join(root, "math.ts");
	const consumerPath = join(root, "consumer.ts");
	const source = "export function add(a: number, b: number) { return a + b; }\n";
	const consumer = 'import { add } from "./math";\nexport const result = add(1, 2);\n';
	writeFileSync(sourcePath, source);
	writeFileSync(consumerPath, consumer);
	writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
	let computations = 0;
	let formats = 0;
	let version = 1;
	const token = (text: string, line: number, newText: string) => {
		const character = (text.split("\n")[line - 1] ?? "").indexOf("add") + 1;
		return { range: { start: { line, character }, end: { line, character: character + 3 } }, newText };
	};
	const renameEdit = (newName: string): ParsedWorkspaceEdit => {
		computations++;
		return {
			operations: [
				{ kind: "text", path: sourcePath, version: 1, edits: [token(source, 1, newName)] },
				{ kind: "text", path: consumerPath, version: 1, edits: [token(consumer, 1, newName), token(consumer, 2, newName)] },
			],
		};
	};
	const index: ClosableSymbolIndex & CodeIntelligencePort = {
		provenance,
		findSymbols: async () => ({ symbols: [], truncated: false, provenance }),
		goToDefinition: async () => [],
		goToImplementation: async () => [],
		findReferences: async () => [{ path: consumerPath, line: 1, character: 10 }],
		hover: async () => undefined,
		documentSymbols: async (path) =>
			path === sourcePath
				? [
						{
							name: "add",
							kind: "function",
							range: { path, start: { line: 1, character: 1 }, end: { line: 1, character: source.length } },
							selectionRange: { path, start: { line: 1, character: 17 }, end: { line: 1, character: 20 } },
							children: [],
						},
					]
				: [],
		diagnostics: async (path) =>
			formatted && path === sourcePath && readFileSync(path, "utf8").includes("return a + b;")
				? [
						{
							range: { path, start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
							severity: "warning",
							message: "unformatted",
							source: "fixture",
						},
					]
				: [],
		prepareCallHierarchy: async () => [],
		incomingCalls: async () => [],
		outgoingCalls: async () => [],
		documentVersion: () => version,
		rename: async (_at, newName) => renameEdit(newName),
		codeActions: async (query) => [{ path: query.path, title: "Rename tokens", preferred: true, diagnostics: [], edit: renameEdit("sum") }],
		close: async () => {},
	};
	const service = createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolIndex: () => index,
		...(formatted
			? {
					formatContent: async (_path: string, content: string) => {
						formats++;
						return content.replace("return a + b;", "return (a + b);");
					},
				}
			: {}),
	});
	services.push(service);
	const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
	const preview = (format = false, maxBytes = 100000) =>
		service.dispatch("workspace.previewRename", {
			workspaceId,
			path: sourcePath,
			line: 1,
			character: 17,
			newName: "sum",
			maxFiles: 20,
			maxEdits: 100,
			maxBytes,
			format,
		});
	return {
		root,
		sourcePath,
		consumerPath,
		source,
		consumer,
		service,
		workspaceId,
		preview,
		computations: () => computations,
		formats: () => formats,
		version: (value: number) => {
			version = value;
		},
	};
}

it("symbol rename previews exact diffs without writing and applies without recomputation", async () => {
	const setup = await fixture();
	const preview = await setup.preview();
	expect(preview.affectedPaths).toEqual([setup.sourcePath, setup.consumerPath]);
	expect(preview.files[0]?.patch).toContain("+export function sum");
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
	Object.assign(preview.files[0] ?? {}, { afterContent: "poison" });
	const applied = await setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: setup.workspaceId, previewId: preview.id });
	expect(setup.computations()).toBe(1);
	expect(readFileSync(setup.sourcePath, "utf8")).toContain("export function sum");
	expect(readFileSync(setup.consumerPath, "utf8")).toContain("sum(1, 2)");
	await setup.service.dispatch("workspace.revertMutationTransaction", { workspaceId: setup.workspaceId, transactionId: applied.transactionId });
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
	expect(readFileSync(setup.consumerPath, "utf8")).toBe(setup.consumer);
});

it("stale, wrong-workspace, consumed and version-drifted plans never write", async () => {
	const setup = await fixture();
	const preview = await setup.preview();
	const second = await fixture();
	await expect(setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: second.workspaceId, previewId: preview.id })).rejects.toThrow();
	writeFileSync(setup.consumerPath, `${setup.consumer}// changed\n`);
	await expect(setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: setup.workspaceId, previewId: preview.id })).rejects.toThrow();
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
	await expect(setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: setup.workspaceId, previewId: preview.id })).rejects.toThrow();
	writeFileSync(setup.consumerPath, setup.consumer);
	const next = await setup.preview();
	setup.version(2);
	await expect(setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: setup.workspaceId, previewId: next.id })).rejects.toThrow();
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
});

it("formatted final bytes are previewed, recorded and reverted without formatting during apply", async () => {
	const setup = await fixture(true);
	const preview = await setup.preview(true);
	expect(preview.formatted).toBe(true);
	expect(preview.files[0]?.afterContent).toContain("return (a + b);");
	expect(setup.formats()).toBe(2);
	const applied = await setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: setup.workspaceId, previewId: preview.id });
	expect(setup.formats()).toBe(2);
	expect(applied.formatted).toBe(true);
	const history = await setup.service.dispatch("workspace.mutationHistory", { workspaceId: setup.workspaceId, path: setup.sourcePath, maxResults: 10 });
	expect(history.entries[0]?.afterHash).toBe(contentHashOf(preview.files[0]?.afterContent ?? ""));
	await setup.service.dispatch("workspace.revertMutationTransaction", { workspaceId: setup.workspaceId, transactionId: applied.transactionId });
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
});

it("missing formatters and oversize plans fail before writing", async () => {
	const setup = await fixture();
	await expect(setup.preview(true)).rejects.toThrow();
	await expect(setup.preview(false, 100)).rejects.toThrow();
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
});

it("file moves require a fresh graph and preview every moved/import-rewritten path", async () => {
	const setup = await fixture();
	const reexportPath = join(setup.root, "reexport.ts");
	const reexport = 'export { add as alias } from "./math";\nimport "./math";\n';
	writeFileSync(reexportPath, reexport);
	const input = {
		workspaceId: setup.workspaceId,
		fromPath: setup.sourcePath,
		toPath: join(setup.root, "renamed.ts"),
		maxFiles: 100,
		maxSymbolsPerFile: 100,
		maxAffectedFiles: 20,
		maxEdits: 100,
		maxBytes: 100000,
	};
	await expect(setup.service.dispatch("workspace.previewFileMove", input)).rejects.toThrow();
	await setup.service.dispatch("workspace.populateSymbolGraph", { workspaceId: setup.workspaceId, maxFiles: 100, maxSymbolsPerFile: 100 });
	const preview = await setup.service.dispatch("workspace.previewFileMove", input);
	expect(preview.coverage).toMatchObject({ status: "cached", maxFiles: 100, maxSymbolsPerFile: 100 });
	expect(preview.coverage?.sourceFingerprint).toBeDefined();
	expect(preview.files.find((file) => file.path === setup.consumerPath)?.afterContent).toContain('"./renamed"');
	expect(preview.files.find((file) => file.path === reexportPath)?.afterContent).toBe('export { add as alias } from "./renamed";\nimport "./renamed";\n');
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
	const applied = await setup.service.dispatch("workspace.applyRenamePreview", { workspaceId: setup.workspaceId, previewId: preview.id });
	expect(readFileSync(input.toPath, "utf8")).toBe(setup.source);
	await setup.service.dispatch("workspace.revertMutationTransaction", { workspaceId: setup.workspaceId, transactionId: applied.transactionId });
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
	expect(readFileSync(setup.consumerPath, "utf8")).toBe(setup.consumer);
	expect(readFileSync(reexportPath, "utf8")).toBe(reexport);
});

it("Vehicle read/write permissions stay distinct", async () => {
	const setup = await fixture();
	await expect(
		setup.service.operationRegistry.invoke(
			"workspace.previewRename",
			1,
			{ workspaceId: setup.workspaceId, path: setup.sourcePath, line: 1, character: 17, newName: "sum", maxFiles: 20, maxEdits: 100, maxBytes: 100000 },
			{ permissions: [] },
		),
	).rejects.toThrow();
	const preview = await setup.preview();
	await expect(
		setup.service.operationRegistry.invoke(
			"workspace.applyRenamePreview",
			1,
			{ workspaceId: setup.workspaceId, previewId: preview.id },
			{ permissions: ["workspace:read"] },
		),
	).rejects.toThrow();
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
});

it("formatted code actions include final bytes in history and diagnostic comparison", async () => {
	const setup = await fixture(true);
	const result = await setup.service.dispatch("workspace.previewCodeActions", {
		workspaceId: setup.workspaceId,
		path: setup.sourcePath,
		range: { start: { line: 1, character: 17 }, end: { line: 1, character: 20 } },
		maxActions: 10,
		maxFiles: 20,
		maxEdits: 100,
		maxBytes: 100000,
		deadlineMs: 10000,
		format: true,
	});
	const action = result.actions[0];
	if (!action) throw new Error("Missing action");
	expect(action.files?.[0]?.afterContent).toContain("return (a + b);");
	const applied = await setup.service.dispatch("workspace.applyCodeAction", { workspaceId: setup.workspaceId, previewId: action.id });
	expect(setup.formats()).toBe(2);
	if (!applied.transactionId) throw new Error("Missing transaction");
	const delta = await setup.service.dispatch("workspace.diagnosticDelta", {
		workspaceId: setup.workspaceId,
		source: { kind: "transaction", transactionId: applied.transactionId },
		maxResults: 100,
		maxBytes: 100000,
	});
	expect(delta.resolved.map((diagnostic) => diagnostic.message)).toContain("unformatted");
	await setup.service.dispatch("workspace.revertMutationTransaction", { workspaceId: setup.workspaceId, transactionId: applied.transactionId });
	expect(readFileSync(setup.sourcePath, "utf8")).toBe(setup.source);
});
