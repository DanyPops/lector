import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVehicleError, type VehicleError } from "@danypops/vehicle-core";
import type { CodeIntelligencePort } from "../src/code-intelligence/port.ts";
import { CodeActionCommandDenied } from "../src/service/code-action-handler.ts";
import type { WorkspaceId } from "../src/service/errors.ts";
import { type ClosableSymbolIndex, createLectorService, type LectorService } from "../src/service.ts";
import { StaleExpectedHash } from "../src/workspace/exact-edit.ts";

let root: string | undefined;
let service: LectorService | undefined;

const fixtureProvenance = {
	fidelity: "semantic",
	backend: "fixture",
	languageId: "typescript",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
} as const;

function fixtureCodeIntelligenceIndex(options: {
	documentVersion: NonNullable<CodeIntelligencePort["documentVersion"]>;
	codeActions: NonNullable<CodeIntelligencePort["codeActions"]>;
}): ClosableSymbolIndex & CodeIntelligencePort {
	return {
		provenance: fixtureProvenance,
		findSymbols: async () => ({ symbols: [], truncated: false, provenance: fixtureProvenance }),
		goToDefinition: async () => [],
		goToImplementation: async () => [],
		findReferences: async () => [],
		hover: async () => undefined,
		documentSymbols: async () => [],
		diagnostics: async () => [],
		prepareCallHierarchy: async () => [],
		incomingCalls: async () => [],
		outgoingCalls: async () => [],
		documentVersion: options.documentVersion,
		codeActions: options.codeActions,
		close: async () => {},
	};
}

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

async function setup(): Promise<{ path: string; workspaceId: WorkspaceId }> {
	root = mkdtempSync(join(tmpdir(), "lector-service-code-action-"));
	mkdirSync(join(root, "src"));
	const path = join(root, "src", "action.ts");
	writeFileSync(path, "export function load(): void {\n\tawait Promise.resolve();\n}\n");
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
	service = createLectorService(new Map(), { allowDynamicOnly: true });
	const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
	return { path, workspaceId };
}

async function preview(path: string, workspaceId: WorkspaceId) {
	if (!service) throw new Error("service unavailable");
	const diagnostics = await service.dispatch("workspace.diagnostics", { workspaceId, path, maxResults: 100, maxBytes: 100_000 });
	const target = diagnostics.diagnostics.find(({ code }) => code === 1308);
	if (!target) throw new Error("expected TypeScript await diagnostic");
	return service.dispatch("workspace.previewCodeActions", {
		workspaceId,
		path,
		range: target.range,
		diagnostics: [target],
		only: ["quickfix"],
		maxActions: 10,
		maxEdits: 100,
		maxFiles: 10,
		maxBytes: 100_000,
		deadlineMs: 10_000,
	});
}

describe("workspace code actions", () => {
	it("previews, atomically applies, and transaction-reverts a TypeScript quick fix", async () => {
		const { path, workspaceId } = await setup();
		const result = await preview(path, workspaceId);
		const action = result.actions.find(({ title }) => /async/i.test(title));
		expect(action?.affectedPaths).toEqual([path]);
		expect(action?.edit?.operations.length).toBeGreaterThan(0);
		if (!action) throw new Error("expected async quick fix");

		const applied = await service?.dispatch("workspace.applyCodeAction", { workspaceId, previewId: action.id });
		expect(applied?.touchedPaths).toEqual([path]);
		expect(applied?.transactionId).toBeDefined();
		expect(readFileSync(path, "utf8")).toContain("export async function load");

		if (!applied?.transactionId) throw new Error("expected transaction id");
		await service?.dispatch("workspace.revertMutationTransaction", { workspaceId, transactionId: applied.transactionId });
		expect(readFileSync(path, "utf8")).toContain("export function load");
	}, 30_000);

	it("applies an unchanged edit when the synchronized document version is unavailable", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-unavailable-version-code-action-"));
		const path = join(root, "action.ts");
		writeFileSync(path, "export const value = 1;\n");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () =>
				fixtureCodeIntelligenceIndex({
					documentVersion: () => undefined,
					codeActions: async () => [
						{
							path,
							title: "Insert marker",
							preferred: true,
							diagnostics: [],
							edit: {
								operations: [
									{
										kind: "text" as const,
										path,
										version: 1,
										edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: "// fixed\n" }],
									},
								],
							},
						},
					],
				}),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const result = await service.dispatch("workspace.previewCodeActions", {
			workspaceId,
			path,
			range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
			maxActions: 10,
			maxEdits: 10,
			maxFiles: 10,
			maxBytes: 10_000,
			deadlineMs: 1_000,
		});
		const action = result.actions[0];
		if (!action) throw new Error("expected code action");

		await service.dispatch("workspace.applyCodeAction", { workspaceId, previewId: action.id });

		expect(readFileSync(path, "utf8")).toStartWith("// fixed");
	}, 20_000);

	it("keeps command-only actions opt-in and denies guarded apply", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-command-code-action-"));
		const path = join(root, "action.ts");
		writeFileSync(path, "export const value = 1;\n");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () =>
				fixtureCodeIntelligenceIndex({
					documentVersion: () => 1,
					codeActions: async (query) => {
						if (query.only?.includes("source.outside")) {
							return [
								{
									path,
									title: "Edit outside",
									preferred: false,
									diagnostics: [],
									edit: {
										operations: [
											{
												kind: "text" as const,
												path: join(tmpdir(), "outside-code-action.ts"),
												edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: "x" }],
											},
										],
									},
								},
							];
						}
						if (query.only?.includes("source.stale-version")) {
							return [
								{
									path,
									title: "Stale version",
									preferred: false,
									diagnostics: [],
									edit: {
										operations: [
											{
												kind: "text" as const,
												path,
												version: 2,
												edits: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, newText: "x" }],
											},
										],
									},
								},
							];
						}
						return [{ path, title: "Run generator", preferred: false, diagnostics: [], command: { title: "Run generator", command: "fixture.generate" } }];
					},
				}),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const request = {
			workspaceId,
			path,
			range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
			maxActions: 10,
			maxEdits: 10,
			maxFiles: 10,
			maxBytes: 10_000,
			deadlineMs: 1_000,
			only: ["source.command"],
		};
		expect((await service.dispatch("workspace.previewCodeActions", request)).actions).toEqual([]);
		const optedIn = await service.dispatch("workspace.previewCodeActions", { ...request, includeCommandActions: true });
		expect(optedIn.actions).toHaveLength(1);
		const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({ ...optedIn, actions: [] }), "utf8");
		const byteBounded = await service.dispatch("workspace.previewCodeActions", {
			...request,
			includeCommandActions: true,
			maxBytes: emptyEnvelopeBytes,
		});
		expect(byteBounded.actions).toEqual([]);
		expect(byteBounded.truncated).toBe(true);
		const action = optedIn.actions[0];
		if (!action) throw new Error("expected command action");
		await expect(service.dispatch("workspace.applyCodeAction", { workspaceId, previewId: action.id })).rejects.toBeInstanceOf(CodeActionCommandDenied);
		const outsideError = await service.operationRegistry
			.invoke("workspace.previewCodeActions", 1, { ...request, only: ["source.outside"] }, { permissions: ["workspace:read"] })
			.catch((caught: unknown) => caught);
		expect(isVehicleError(outsideError)).toBe(true);
		expect((outsideError as VehicleError).code).toBe("workspace-edit-outside-root");
		const staleVersionPreview = await service.dispatch("workspace.previewCodeActions", { ...request, only: ["source.stale-version"] });
		const staleVersionAction = staleVersionPreview.actions[0];
		if (!staleVersionAction) throw new Error("expected stale-version action");
		const staleVersionError = await service.operationRegistry
			.invoke("workspace.applyCodeAction", 1, { workspaceId, previewId: staleVersionAction.id }, { permissions: ["workspace:write"] })
			.catch((caught: unknown) => caught);
		expect(isVehicleError(staleVersionError)).toBe(true);
		expect((staleVersionError as VehicleError).code).toBe("stale-code-action-document-version");
	}, 20_000);

	it("rejects apply after the previewed file changes", async () => {
		const { path, workspaceId } = await setup();
		const result = await preview(path, workspaceId);
		const action = result.actions.find(({ title }) => /async/i.test(title));
		if (!action) throw new Error("expected async quick fix");
		writeFileSync(path, `${readFileSync(path, "utf8")}\n// concurrent change\n`);

		await expect(service?.dispatch("workspace.applyCodeAction", { workspaceId, previewId: action.id })).rejects.toBeInstanceOf(StaleExpectedHash);
		expect(readFileSync(path, "utf8")).toContain("// concurrent change");
	}, 30_000);
});
