/**
 * Dogfood: a real typescript-language-server process, queried against
 * Lector's own source tree, not a fixture. The same dogfood pattern
 * extends to goToDefinition/findReferences/hover/documentSymbols.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import { diagnostics } from "../../../src/code-intelligence/diagnostics.ts";
import { documentSymbols } from "../../../src/code-intelligence/document-symbols.ts";
import { findReferences } from "../../../src/code-intelligence/find-references.ts";
import { goToDefinition } from "../../../src/code-intelligence/go-to-definition.ts";
import { goToImplementation } from "../../../src/code-intelligence/go-to-implementation.ts";
import { hoverAt } from "../../../src/code-intelligence/hover-at.ts";
import { type LanguageServerDescriptor, TYPESCRIPT_DESCRIPTOR } from "../../../src/code-intelligence/language-server-descriptor.ts";
import { LanguageFileOutsideWorkspace, LanguageServerProvisioningUnavailable, LspSymbolIndex } from "../../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { InMemoryContentCache } from "../../../src/content-cache/in-memory-content-cache.ts";
import { contentHashOf } from "../../../src/content-identity/content-hash.ts";
import { InstallLocation } from "../../../src/lsp-provisioning/install-location.ts";
import { LanguageServerProvisioner } from "../../../src/lsp-provisioning/language-server-provisioner.ts";
import type { LanguageServerProvisionerPort } from "../../../src/lsp-provisioning/port.ts";
import { incomingCalls } from "../../../src/symbol-graph/incoming-calls.ts";
import { outgoingCalls } from "../../../src/symbol-graph/outgoing-calls.ts";
import { prepareCallHierarchy } from "../../../src/symbol-graph/prepare-call-hierarchy.ts";
import { findWorkspaceSymbols } from "../../../src/workspace/find-workspace-symbols.ts";
import { findPositionOf } from "../../support/find-position.ts";
import { startGithubReleaseFixture } from "../../support/github-release-fixture.ts";

const LECTOR_ROOT = new URL("../../..", import.meta.url).pathname;
const EXACT_EDIT_FILE = join(LECTOR_ROOT, "src/workspace/exact-edit.ts");
// The real, current consumer of workspace/exact-edit.ts's exactEdit -- moved here from
// service.ts by the createLectorService SRP extraction (service/workspace-file-handlers.ts).
const WORKSPACE_FILE_HANDLERS_FILE = join(LECTOR_ROOT, "src/service/workspace-file-handlers.ts");
const FIND_WORKSPACE_SYMBOLS_FILE = join(LECTOR_ROOT, "src/workspace/find-workspace-symbols.ts");
const SYMBOL_INDEX_PORT_FILE = join(LECTOR_ROOT, "src/code-intelligence/symbol-index-port.ts");
const SYMBOL_GRAPH_PORT_FILE = join(LECTOR_ROOT, "src/symbol-graph/port.ts");
const LSP_SYMBOL_INDEX_FILE = join(LECTOR_ROOT, "src/code-intelligence/lsp/lsp-symbol-index.ts");
const EVIL_LSP_SERVER = join(LECTOR_ROOT, "test/support/evil-lsp-server.ts");

let index: LspSymbolIndex | undefined;
afterEach(async () => {
	await index?.close();
	index = undefined;
});

describe("LspSymbolIndex managed spawn fallback", () => {
	it("provisions once after ENOENT, retries with the installed binary, and reuses the warm process", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-managed-lsp-"));
		writeFileSync(join(root, "seed.ts"), "export const seed = 1;\n");
		const source = { kind: "npm", packageName: "fixture-lsp", binName: "fixture-lsp" } as const;
		const descriptor: LanguageServerDescriptor = {
			languageId: "fixture",
			backendId: "fixture-lsp",
			extensions: [".ts"],
			launch: { kind: "system-binary", command: "lector-definitely-missing-lsp" },
			provisioning: source,
			args: [EVIL_LSP_SERVER],
			rootMarkers: [],
			commonSeedCandidates: ["seed.ts"],
			settleMs: 0,
		};
		let provisionCalls = 0;
		const provisioner: LanguageServerProvisionerPort = {
			async ensureInstalled() {
				provisionCalls += 1;
				return {
					kind: "installed",
					binPath: process.execPath,
					receipt: { packageId: "fixture-lsp", source, resolvedVersion: "1.0.0", binPath: process.execPath, installedAt: new Date(0).toISOString() },
				};
			},
		};
		index = new LspSymbolIndex(root, descriptor, "seed.ts", { provisioner });

		expect(index.processId).toBeUndefined();
		expect(provisionCalls).toBe(0);
		await findWorkspaceSymbols(index, "anything");
		const processId = index.processId;
		expect(processId).toBeDefined();
		expect(provisionCalls).toBe(1);

		await findWorkspaceSymbols(index, "again");
		expect(index.processId).toBe(processId);
		expect(provisionCalls).toBe(1);
		await index.close();
		index = undefined;
		rmSync(root, { recursive: true, force: true });
	}, 20_000);

	it("runs the real provisioner, installs a release asset, and spawns the resulting executable", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-managed-lsp-"));
		const installRoot = mkdtempSync(join(tmpdir(), "lector-managed-lsp-install-"));
		writeFileSync(join(root, "seed.ts"), "export const seed = 1;\n");
		const assetName = "fixture-lsp-linux-x64";
		const wrapper = Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "${EVIL_LSP_SERVER}" "$@"\n`);
		const fixture = startGithubReleaseFixture({ repo: "acme/fixture-lsp", tagName: "1.0.0", assets: [{ name: assetName, bytes: wrapper }] });
		const descriptor: LanguageServerDescriptor = {
			languageId: "fixture",
			backendId: "fixture-lsp",
			extensions: [".ts"],
			launch: { kind: "system-binary", command: "lector-definitely-missing-lsp" },
			provisioning: {
				kind: "github-release",
				repo: "acme/fixture-lsp",
				assetName: () => assetName,
				binPathInArchive: () => "fixture-lsp",
			},
			args: [],
			rootMarkers: [],
			commonSeedCandidates: ["seed.ts"],
			settleMs: 0,
		};
		const provisioner = new LanguageServerProvisioner(new InstallLocation(installRoot), {
			githubRelease: { apiBaseUrl: fixture.apiBaseUrl },
			resolvePlatform: async () => ({ os: "linux", arch: "x64", libc: "glibc" }),
		});
		index = new LspSymbolIndex(root, descriptor, "seed.ts", { provisioner });

		try {
			await findWorkspaceSymbols(index, "anything");
			expect(index.processId).toBeDefined();
		} finally {
			await index.close();
			index = undefined;
			fixture.stop();
			rmSync(root, { recursive: true, force: true });
			rmSync(installRoot, { recursive: true, force: true });
		}
	}, 20_000);

	it("does not provision when an installed command starts but fails for a non-ENOENT reason", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-managed-lsp-"));
		writeFileSync(join(root, "seed.ts"), "export const seed = 1;\n");
		let provisionCalls = 0;
		const descriptor: LanguageServerDescriptor = {
			languageId: "fixture",
			backendId: "fixture-lsp",
			extensions: [".ts"],
			launch: { kind: "system-binary", command: process.execPath },
			provisioning: { kind: "npm", packageName: "fixture-lsp", binName: "fixture-lsp" },
			args: [join(root, "missing-server-script.ts")],
			rootMarkers: [],
			commonSeedCandidates: ["seed.ts"],
			settleMs: 0,
		};
		const provisioner: LanguageServerProvisionerPort = {
			async ensureInstalled() {
				provisionCalls += 1;
				return { kind: "unavailable", reason: "must not be reached" };
			},
		};
		index = new LspSymbolIndex(root, descriptor, "seed.ts", { provisioner });

		await expect(findWorkspaceSymbols(index, "anything")).rejects.toThrow();
		expect(provisionCalls).toBe(0);
		rmSync(root, { recursive: true, force: true });
	}, 20_000);

	it("surfaces a typed actionable error when managed installation is unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-managed-lsp-"));
		writeFileSync(join(root, "seed.ts"), "export const seed = 1;\n");
		const descriptor: LanguageServerDescriptor = {
			languageId: "fixture",
			backendId: "fixture-lsp",
			extensions: [".ts"],
			launch: { kind: "system-binary", command: "lector-definitely-missing-lsp" },
			provisioning: { kind: "npm", packageName: "fixture-lsp", binName: "fixture-lsp" },
			args: [],
			rootMarkers: [],
			commonSeedCandidates: ["seed.ts"],
			settleMs: 0,
		};
		const provisioner: LanguageServerProvisionerPort = {
			async ensureInstalled() {
				return { kind: "unavailable", reason: "no matching platform asset" };
			},
		};
		index = new LspSymbolIndex(root, descriptor, "seed.ts", { provisioner });

		const query = findWorkspaceSymbols(index, "anything");
		await expect(query).rejects.toThrow(LanguageServerProvisioningUnavailable);
		await expect(query).rejects.toThrow("no matching platform asset");
		rmSync(root, { recursive: true, force: true });
	}, 20_000);
});

describe("LspSymbolIndex configured for TypeScript", () => {
	it("finds a real, known symbol in Lector's own source via a live typescript-language-server", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");

		const results = await findWorkspaceSymbols(index, "exactEdit");

		// Real tsserver behavior, not an assumption: navto only surfaces symbols in files it
		// has actually loaded. With only the seed file (src/index.ts) opened, the match found
		// is the barrel's re-export binding (kind "variable"), not exact-edit.ts's original
		// `function` declaration -- tsserver never independently opened that file. Still a
		// materially useful result: it correctly names and locates the symbol.
		const match = results.symbols.find((symbol) => symbol.name === "exactEdit");
		expect(match).toBeDefined();
		expect(match?.location.path).toContain("lector");
		expect(match?.location.line).toBeGreaterThan(0);
	}, 20_000);

	it("returns an empty array for a query matching nothing, not an error", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");

		const results = await findWorkspaceSymbols(index, "ThisSymbolDefinitelyDoesNotExistAnywhere");

		expect(results.symbols).toEqual([]);
	}, 20_000);

	it("goToDefinition navigates a method-access usage to the interface member that declares it", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		// find-workspace-symbols.ts's own body calls index.findSymbols(query), where `index` is
		// typed SymbolIndexPort -- a real cross-file member access, not a plain imported-value
		// usage. Real, confirmed tsserver behavior (not assumed): a plain value-import usage's
		// definition stops at the local import specifier in the SAME file rather than crossing
		// into the exporting module (typescript-language-server has no standard-LSP way to force
		// the deeper "go to source definition" hop editors like VS Code offer as an extra command);
		// a member-access call like this one does cross files correctly.
		const usage = findPositionOf(FIND_WORKSPACE_SYMBOLS_FILE, ".findSymbols(query, bounds)");

		const locations = await goToDefinition(index, { path: FIND_WORKSPACE_SYMBOLS_FILE, line: usage.line, character: usage.character + 2 });

		expect(locations.length).toBeGreaterThan(0);
		expect(locations[0]?.path).toBe(SYMBOL_INDEX_PORT_FILE);
	}, 20_000);

	it("goToImplementation crosses a real port boundary that goToDefinition cannot -- SymbolGraphPort.addNode to both of its concrete adapters", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const declaration = findPositionOf(SYMBOL_GRAPH_PORT_FILE, "addNode(node: SymbolNode)");
		const at = { path: SYMBOL_GRAPH_PORT_FILE, line: declaration.line, character: declaration.character + 1 };

		const locations = await goToImplementation(index, at);

		const paths = locations.map((location) => location.path);
		expect(paths).toContain(join(LECTOR_ROOT, "src/symbol-graph/in-memory-symbol-graph.ts"));
		expect(paths).toContain(join(LECTOR_ROOT, "src/symbol-graph/sqlite-symbol-graph.ts"));
	}, 20_000);

	it("findReferences reliably finds usages within the seed file's own transitive import graph", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const declaration = findPositionOf(EXACT_EDIT_FILE, "export async function exactEdit");
		// Position on the identifier itself, past "export async function ".
		const at = { path: EXACT_EDIT_FILE, line: declaration.line, character: declaration.character + "export async function ".length };

		const references = await findReferences(index, at, true);

		// Reliable across runs: the declaration itself, plus index.ts's own re-export of it --
		// both reachable by following the seed file's own imports. Deliberately NOT asserting
		// whether service.ts's usage (a reverse-dependent tsserver only finds once it has
		// progressed its own background project loading far enough) shows up here: confirmed
		// directly, across repeated runs, that this is genuinely timing/scheduling-sensitive --
		// not a fixed architectural limit -- so asserting either way about it would be flaky.
		// The next test shows the deterministic way to guarantee a specific file is included.
		const files = new Set(references.map((location) => location.path));
		expect(references.length).toBeGreaterThanOrEqual(2);
		expect(files.has(EXACT_EDIT_FILE)).toBe(true);
		expect(files.has(join(LECTOR_ROOT, "src/index.ts"))).toBe(true);
	}, 20_000);

	it("findReferences reliably includes a consumer file's usage once that file has itself been queried (opened)", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		// Querying documentSymbols against workspace-file-handlers.ts first makes tsserver track it
		// immediately, rather than depending on how far its own background project loading has
		// progressed -- this is the deterministic, intended path: an agent that has already looked
		// at a file is guaranteed that file's usages are included, rather than references being a
		// matter of luck.
		await documentSymbols(index, WORKSPACE_FILE_HANDLERS_FILE);

		const declaration = findPositionOf(EXACT_EDIT_FILE, "export async function exactEdit");
		const at = { path: EXACT_EDIT_FILE, line: declaration.line, character: declaration.character + "export async function ".length };
		const references = await findReferences(index, at, true);

		const files = new Set(references.map((location) => location.path));
		expect(files.has(WORKSPACE_FILE_HANDLERS_FILE)).toBe(true);
	}, 20_000);

	it("hover returns real type/doc information for a known declaration, not an empty result", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const declaration = findPositionOf(EXACT_EDIT_FILE, "export async function exactEdit");
		const at = { path: EXACT_EDIT_FILE, line: declaration.line, character: declaration.character + "export async function ".length };

		const hover = await hoverAt(index, at);

		expect(hover).toBeDefined();
		expect(hover?.contents.length).toBeGreaterThan(0);
		expect(hover?.contents).toContain("exactEdit");
	}, 20_000);

	it("prepareCallHierarchy resolves a real method declaration to a call-hierarchy root", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const declaration = findPositionOf(LSP_SYMBOL_INDEX_FILE, "private async ensureFileOpen");
		const at = { path: LSP_SYMBOL_INDEX_FILE, line: declaration.line, character: declaration.character + "private async ".length };

		const roots = await prepareCallHierarchy(index, at);

		expect(roots.length).toBeGreaterThan(0);
		expect(roots[0]?.name).toBe("ensureFileOpen");
	}, 20_000);

	it("incomingCalls finds a real caller of a method used multiple times within its own declaring file", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const declaration = findPositionOf(LSP_SYMBOL_INDEX_FILE, "private async ensureFileOpen");
		const at = { path: LSP_SYMBOL_INDEX_FILE, line: declaration.line, character: declaration.character + "private async ".length };

		const callers = await incomingCalls(index, at);

		// ensureFileOpen is called from goToDefinition, findReferences, hover, documentSymbols,
		// diagnostics, and prepareCallHierarchyRaw -- all within this same seed-reachable file.
		expect(callers.length).toBeGreaterThan(0);
		expect(callers.every((call) => call.from.location.path === LSP_SYMBOL_INDEX_FILE)).toBe(true);
	}, 20_000);

	it("outgoingCalls finds the real methods a function itself calls", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");
		const declaration = findPositionOf(LSP_SYMBOL_INDEX_FILE, "async diagnostics(path");
		const at = { path: LSP_SYMBOL_INDEX_FILE, line: declaration.line, character: declaration.character + "async ".length };

		const callees = await outgoingCalls(index, at);

		// diagnostics() calls ensureInitialized, ensureFileOpen, and waitForDiagnosticsNotification.
		const names = callees.map((call) => call.to.name);
		expect(names).toContain("ensureFileOpen");
	}, 20_000);

	it("prepareCallHierarchy returns an empty array for a position with no resolvable symbol, not an error", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");

		const roots = await prepareCallHierarchy(index, { path: LSP_SYMBOL_INDEX_FILE, line: 1, character: 1 });

		expect(roots).toEqual([]);
	}, 20_000);

	it("documentSymbols lists the declarations of one specific file directly, with the real declaration kind", async () => {
		index = new LspSymbolIndex(LECTOR_ROOT, TYPESCRIPT_DESCRIPTOR, "src/index.ts");

		const symbols = await documentSymbols(index, EXACT_EDIT_FILE);

		const exactEditEntry = symbols.find((symbol) => symbol.name === "exactEdit");
		expect(exactEditEntry).toBeDefined();
		// Queried directly against its declaring file (not a workspace/symbol search hitting a
		// barrel's re-export binding), this must be the real function declaration.
		expect(exactEditEntry?.kind).toBe("function");
		expect(exactEditEntry?.range.path).toBe(EXACT_EDIT_FILE);
	}, 20_000);
});

describe("LspSymbolIndex configured for TypeScript -- diagnostics", () => {
	// A real type error can't live in this project's own tracked source (it would break this
	// project's own typecheck), so diagnostics needs its own throwaway fixture project rather
	// than dogfooding LECTOR_ROOT like every other test above.
	let fixtureRoot: string | undefined;

	afterEach(async () => {
		await index?.close();
		index = undefined;
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function buildFixture(): string {
		const root = mkdtempSync(join(tmpdir(), "lector-diagnostics-fixture-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		writeFileSync(join(root, "broken.ts"), 'export const total: number = "not a number";\n');
		writeFileSync(join(root, "clean.ts"), "export const total: number = 1 + 1;\n");
		return root;
	}

	it("surfaces a real type error as an error-severity diagnostic", async () => {
		fixtureRoot = buildFixture();
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "broken.ts");

		const results = await diagnostics(index, join(fixtureRoot, "broken.ts"));

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.severity).toBe("error");
		expect(results[0]?.message).toContain("not assignable");
		expect(results[0]?.range.path).toBe(join(fixtureRoot, "broken.ts"));
	}, 20_000);

	it("returns an empty array for a file with no issues, not a fabricated result", async () => {
		fixtureRoot = buildFixture();
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "broken.ts");

		const results = await diagnostics(index, join(fixtureRoot, "clean.ts"));

		expect(results).toEqual([]);
	}, 20_000);

	it("keeps two files' diagnostics independent -- querying one never leaks the other's issues", async () => {
		fixtureRoot = buildFixture();
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "broken.ts");

		const brokenResults = await diagnostics(index, join(fixtureRoot, "broken.ts"));
		const cleanResults = await diagnostics(index, join(fixtureRoot, "clean.ts"));

		expect(brokenResults.length).toBeGreaterThan(0);
		expect(cleanResults).toEqual([]);
	}, 20_000);
});

describe("LspSymbolIndex cold target-document seeding", () => {
	it("opens a requested file beyond the workspace discovery bound before scanning for an unrelated seed", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-cold-target-"));
		const targetDirectory = join(root, "a", "b", "c", "d", "e");
		const target = join(targetDirectory, "target.ts");
		mkdirSync(targetDirectory, { recursive: true });
		writeFileSync(target, "export function deepTarget(): string { return 'ready'; }\n");
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR);
		try {
			const symbols = await documentSymbols(index, target);
			expect(symbols.some((symbol) => symbol.name === "deepTarget")).toBe(true);
		} finally {
			await index.close();
			index = undefined;
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("uses the target seed for every cold file-position operation", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-cold-operations-"));
		const targetDirectory = join(root, "a", "b", "c", "d", "e");
		const target = join(targetDirectory, "target.ts");
		mkdirSync(targetDirectory, { recursive: true });
		writeFileSync(target, "export function leaf(): number { return 1; }\nexport function caller(): number { return leaf(); }\n");
		const leafDeclaration = findPositionOf(target, "leaf():");
		const leafCall = findPositionOf(target, "leaf();");
		const callerDeclaration = findPositionOf(target, "caller():");
		const operations: readonly [string, (cold: LspSymbolIndex) => Promise<unknown>][] = [
			["definition", (cold) => goToDefinition(cold, { path: target, line: leafCall.line, character: leafCall.character })],
			["implementation", (cold) => goToImplementation(cold, { path: target, line: leafDeclaration.line, character: leafDeclaration.character })],
			["references", (cold) => findReferences(cold, { path: target, line: leafDeclaration.line, character: leafDeclaration.character }, true)],
			["hover", (cold) => hoverAt(cold, { path: target, line: leafDeclaration.line, character: leafDeclaration.character })],
			["document symbols", (cold) => documentSymbols(cold, target)],
			["diagnostics", (cold) => diagnostics(cold, target)],
			["prepare call hierarchy", (cold) => prepareCallHierarchy(cold, { path: target, line: callerDeclaration.line, character: callerDeclaration.character })],
			["incoming calls", (cold) => incomingCalls(cold, { path: target, line: leafDeclaration.line, character: leafDeclaration.character })],
			["outgoing calls", (cold) => outgoingCalls(cold, { path: target, line: callerDeclaration.line, character: callerDeclaration.character })],
		];
		try {
			for (const [, operation] of operations) {
				const cold = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR);
				try {
					expect(await operation(cold)).toBeDefined();
				} finally {
					await cold.close();
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects a requested seed outside the workspace before spawning a server", async () => {
		const root = mkdtempSync(join(tmpdir(), "lector-seed-root-"));
		const outsideRoot = mkdtempSync(join(tmpdir(), "lector-seed-outside-"));
		const target = join(outsideRoot, "target.ts");
		writeFileSync(target, "export const outside = true;\n");
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR);
		try {
			await expect(documentSymbols(index, target)).rejects.toBeInstanceOf(LanguageFileOutsideWorkspace);
			expect(index.processId).toBeUndefined();
		} finally {
			await index.close();
			index = undefined;
			rmSync(root, { recursive: true, force: true });
			rmSync(outsideRoot, { recursive: true, force: true });
		}
	});
});

describe("LspSymbolIndex auto-discovered seed file in a monorepo with no root tsconfig", () => {
	// Reproduces a real bug found live against this project's own repo: registering a monorepo
	// root (no tsconfig.json at that level) let a bounded, alphabetically-sorted scan pick a
	// standalone root-level config file as the seed -- a real .ts file, but with no tsconfig
	// covering it, silently limiting workspace/symbol to an unrelated, near-empty project.
	let monorepoRoot: string | undefined;
	afterEach(() => {
		if (monorepoRoot) rmSync(monorepoRoot, { recursive: true, force: true });
		monorepoRoot = undefined;
	});

	function buildMonorepoFixture(): string {
		const root = mkdtempSync(join(tmpdir(), "lector-monorepo-seed-fixture-"));
		writeFileSync(join(root, "aaa-root-config.ts"), "export {};\n"); // alphabetically first, no project
		mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
		writeFileSync(
			join(root, "packages", "app", "tsconfig.json"),
			JSON.stringify({ compilerOptions: { module: "ESNext", target: "ESNext" }, include: ["src"] }),
		);
		writeFileSync(join(root, "packages", "app", "src", "index.ts"), "export function realProjectExport() {}\n");
		return root;
	}

	it("finds a symbol declared in the real project, not silently empty because a stray root config file won the seed-file scan", async () => {
		monorepoRoot = buildMonorepoFixture();
		index = new LspSymbolIndex(monorepoRoot, TYPESCRIPT_DESCRIPTOR); // no explicit seedFile -- exercises real auto-discovery

		const results = await findWorkspaceSymbols(index, "realProjectExport");

		expect(results.symbols.some((symbol) => symbol.name === "realProjectExport")).toBe(true);
	}, 20_000);
});

describe("LspSymbolIndex content-cache wiring", () => {
	let fixtureRoot: string | undefined;
	afterEach(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function buildFixture(): { root: string; content: string } {
		const root = mkdtempSync(join(tmpdir(), "lector-lsp-content-cache-"));
		const content = "export function cachedFn(): number {\n\treturn 1;\n}\n";
		writeFileSync(join(root, "a.ts"), content);
		writeFileSync(join(root, "tsconfig.json"), "{}");
		return { root, content };
	}

	it("warms an injected ContentCachePort's rawContent lens for a file it reads, keyed by that content's real hash", async () => {
		const { root, content } = buildFixture();
		fixtureRoot = root;
		const contentCache = new InMemoryContentCache();
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "a.ts", { contentCache });

		await documentSymbols(index, join(root, "a.ts"));

		const entry = await contentCache.get(contentHashOf(content));
		expect(entry?.rawContent).toBe(content);
	}, 20_000);

	it("re-warms the cache with the NEW content's hash after the file changes on disk, not the stale one", async () => {
		const { root, content } = buildFixture();
		fixtureRoot = root;
		const contentCache = new InMemoryContentCache();
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "a.ts", { contentCache });
		await documentSymbols(index, join(root, "a.ts"));

		const updated = "export function cachedFn(): number {\n\treturn 2;\n}\n";
		writeFileSync(join(root, "a.ts"), updated);
		await documentSymbols(index, join(root, "a.ts"));

		await expect(contentCache.get(contentHashOf(updated))).resolves.toMatchObject({ rawContent: updated });
		// The original hash's entry is untouched (content-addressed -- never invalidated, only superseded by a different hash).
		await expect(contentCache.get(contentHashOf(content))).resolves.toMatchObject({ rawContent: content });
	}, 20_000);

	it("defaults to its own private cache when none is injected -- fully backward compatible", async () => {
		const { root } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "a.ts");

		const symbols = await documentSymbols(index, join(root, "a.ts"));
		expect(symbols.some((symbol) => symbol.name === "cachedFn")).toBe(true);
	}, 20_000);
});

describe("LspSymbolIndex prepareRename/rename", () => {
	let fixtureRoot: string | undefined;
	afterEach(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function buildFixture(): { root: string; mathFile: string; consumerFile: string } {
		const root = mkdtempSync(join(tmpdir(), "lector-lsp-rename-"));
		mkdirSync(join(root, "src"));
		const mathFile = join(root, "src", "math.ts");
		writeFileSync(mathFile, "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n\n// just a comment, nothing renameable here\n");
		const consumerFile = join(root, "src", "consumer.ts");
		writeFileSync(consumerFile, 'import { add } from "./math";\n\nexport function total(): number {\n\treturn add(1, 2);\n}\n');
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
		);
		return { root, mathFile, consumerFile };
	}

	it("prepareRename resolves a real declaration's own range and placeholder text", async () => {
		const { root, mathFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "src/math.ts");

		// "add" starts at column 17 (1-indexed) on line 1: "export function add(..."
		const result = await index.prepareRename?.({ path: mathFile, line: 1, character: 17 });

		expect(result).not.toBeNull();
		expect(result?.placeholder ?? "add").toContain("add");
	});

	it("prepareRename returns null for a position with no renameable symbol, even when the server signals it via a JSON-RPC error rather than a null result", async () => {
		const { root, mathFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "src/math.ts");

		// typescript-language-server answers this position with a JSON-RPC error ("You cannot
		// rename this element."), not a null result -- per spec both mean the same thing.
		const result = await index.prepareRename?.({ path: mathFile, line: 5, character: 5 });

		expect(result).toBeNull();
	});

	it("rename returns a real WorkspaceEdit touching both the declaration and its cross-file usage", async () => {
		const { root, mathFile, consumerFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "src/math.ts");
		// Opens consumer.ts first so the server has it loaded and includes its usage -- the same
		// "findReferences reliably includes a consumer file's usage once queried" precedent already
		// proven elsewhere in this file.
		await documentSymbols(index, consumerFile);

		const edit = await index.rename?.({ path: mathFile, line: 1, character: 17 }, "sum");

		expect(edit).toBeDefined();
		const touchedPaths = edit?.operations.filter((op) => op.kind === "text").map((op) => op.path) ?? [];
		expect(touchedPaths).toContain(mathFile);
		expect(touchedPaths).toContain(consumerFile);
	}, 20_000);

	it("exposes negotiated rename capabilities after a real initialize", async () => {
		const { root, mathFile } = buildFixture();
		fixtureRoot = root;
		index = new LspSymbolIndex(root, TYPESCRIPT_DESCRIPTOR, "src/math.ts");

		await documentSymbols(index, mathFile);

		expect(index.capabilities?.renameProvider).toBe(true);
		expect(index.capabilities?.prepareRenameProvider).toBe(true);
	});
});

describe("LspSymbolIndex open-file logging", () => {
	// Real incident: a ~500-file Go crawl failed half its files against the open-file cap with
	// no logged signal anywhere of why -- nothing between here and the LSP client had a logger.
	let fixtureRoot: string | undefined;
	afterEach(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function recordingLogger(): { logger: Logger; calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> } {
		const calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
		return {
			calls,
			logger: {
				debug: (msg, fields) => calls.push({ level: "debug", msg, fields }),
				info: (msg, fields) => calls.push({ level: "info", msg, fields }),
				warn: (msg, fields) => calls.push({ level: "warn", msg, fields }),
				error: (msg, fields) => calls.push({ level: "error", msg, fields }),
			},
		};
	}

	function buildFixture(): string {
		const root = mkdtempSync(join(tmpdir(), "lector-lsp-logging-"));
		writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
		writeFileSync(join(root, "a.ts"), "export function a(): number {\n\treturn 1;\n}\n");
		writeFileSync(join(root, "b.ts"), "export function b(): number {\n\treturn 2;\n}\n");
		return root;
	}

	it("logs debug on open and on release, with the real path and current/max open-file counts", async () => {
		fixtureRoot = buildFixture();
		const { logger, calls } = recordingLogger();
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "a.ts", { logger });

		const aPath = join(fixtureRoot, "a.ts");
		await documentSymbols(index, aPath);
		await index.releaseFile?.(aPath);

		const opened = calls.find((call) => call.msg === "file opened");
		expect(opened?.fields).toMatchObject({ languageId: "typescript", path: aPath, openFiles: 1 });
		const released = calls.find((call) => call.msg === "file released");
		expect(released?.fields).toMatchObject({ languageId: "typescript", path: aPath, openFiles: 0 });
	}, 20_000);

	it("logs a warn with path/size/max when ensureFileOpen actually rejects at the cap", async () => {
		fixtureRoot = buildFixture();
		const { logger, calls } = recordingLogger();
		index = new LspSymbolIndex(fixtureRoot, TYPESCRIPT_DESCRIPTOR, "a.ts", { logger, maxOpenFiles: 1 });

		const aPath = join(fixtureRoot, "a.ts");
		const bPath = join(fixtureRoot, "b.ts");
		await documentSymbols(index, aPath); // fills the only slot, never released

		await expect(documentSymbols(index, bPath)).rejects.toThrow(/open-files/);

		const rejected = calls.find((call) => call.msg === "open-file limit exceeded");
		expect(rejected?.fields).toMatchObject({ languageId: "typescript", path: bPath, openFiles: 1, maxOpenFiles: 1 });
	}, 20_000);
});
