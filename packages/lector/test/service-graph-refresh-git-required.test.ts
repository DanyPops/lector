/**
 * Proves the automatic graph-freshness watcher requires a real git repository at three tiers:
 * mock (fake GitPort/FileWatcher, no real subprocess -- proves the gate logic itself), monoglot
 * (one real language's real files), and polyglot (several real languages' real files in one
 * workspace). Confirmed live as a real incident: a non-git, broad, or ambiguous root must never
 * get an automatic, unbounded OS-level recursive watcher armed against it -- see
 * service-graph-refresh.test.ts's own header for the sibling "does the watcher work at all"
 * suite, which now only ever exercises real git fixtures for that reason.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentSymbolEntry } from "../src/domain/document-symbol.ts";
import type { IntelligenceProvenance } from "../src/domain/intelligence-provenance.ts";
import type { RepoFetchResult } from "../src/domain/repo-fetch-result.ts";
import type { RepoReference } from "../src/domain/repo-reference.ts";
import type { FileChangeEvent } from "../src/file-watcher/file-change-event.ts";
import type { GitPort } from "../src/git/port.ts";
import type { CodeIntelligencePort } from "../src/ports/code-intelligence-port.ts";
import type { RepoFetcherPort } from "../src/ports/repo-fetcher-port.ts";
import type { ClosableSymbolIndex, LectorService } from "../src/service.ts";
import { createLectorService } from "../src/service.ts";

const PROVENANCE: IntelligenceProvenance = {
	fidelity: "semantic",
	backend: "stub-server",
	languageId: "typescript",
	authority: "language-server",
	freshness: "live-process",
	limitations: [],
};

function stubIndex(): { index: ClosableSymbolIndex & CodeIntelligencePort; documentSymbolsCalls: () => number } {
	let calls = 0;
	const index: ClosableSymbolIndex & CodeIntelligencePort = {
		provenance: PROVENANCE,
		findSymbols: async () => ({ symbols: [], truncated: false, provenance: PROVENANCE }),
		goToDefinition: async () => [],
		goToImplementation: async () => [],
		findReferences: async () => [],
		hover: async () => undefined,
		documentSymbols: async (): Promise<DocumentSymbolEntry[]> => {
			calls++;
			return [];
		},
		diagnostics: async () => [],
		prepareCallHierarchy: async () => [],
		incomingCalls: async () => [],
		outgoingCalls: async () => [],
		releaseFile: async () => {},
		notifyFileChanged: (_event: FileChangeEvent) => {},
		close: async () => {},
	};
	return { index, documentSymbolsCalls: () => calls };
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function initGitRepo(dir: string): void {
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@t.com");
	git(dir, "config", "user.name", "t");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "initial commit");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for the expected condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function neverHappensWithin(predicate: () => boolean, windowMs: number): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < windowMs) {
		if (predicate()) throw new Error("expected condition never to become true within the window, but it did");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const roots: string[] = [];
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

describe("mock: the automatic watcher's own git-repository gate, via a fake GitPort and a spying FileWatcherPort", () => {
	it("never arms the OS watcher when the fake GitPort reports isGitRepository: false", async () => {
		const root = tempDir("lector-mock-non-git-");
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		const stub = stubIndex();
		let watchCalls = 0;
		const fakeGit: GitPort = {
			isGitRepository: async () => false,
			status: async () => ({ current: null, files: [], ahead: 0, behind: 0, tracking: null }),
			log: async () => [],
			diff: async () => ({ diff: "", truncated: false }),
			showFile: async () => undefined,
		};
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => stub.index,
			createGitPort: () => fakeGit,
			createFileWatcher: () => ({
				watch: () => {
					watchCalls++;
					return { close: () => {} };
				},
			}),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		expect(watchCalls).toBe(0);
	});

	it("arms the OS watcher exactly once when the fake GitPort reports isGitRepository: true", async () => {
		const root = tempDir("lector-mock-git-");
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		const stub = stubIndex();
		let watchCalls = 0;
		const fakeGit: GitPort = {
			isGitRepository: async () => true,
			status: async () => ({ current: "main", files: [], ahead: 0, behind: 0, tracking: null }),
			log: async () => [],
			diff: async () => ({ diff: "", truncated: false }),
			showFile: async () => undefined,
		};
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => stub.index,
			createGitPort: () => fakeGit,
			createFileWatcher: () => ({
				watch: () => {
					watchCalls++;
					return { close: () => {} };
				},
			}),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		expect(watchCalls).toBe(1);
	});
});

describe("mock: a remote-origin (repo.fetch) workspace is always treated as git-backed, skipping the redundant real git subprocess check", () => {
	it("arms the OS watcher for a remote-origin workspace even when the injected GitPort would (wrongly) report isGitRepository: false", async () => {
		const root = tempDir("lector-mock-remote-origin-");
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		const stub = stubIndex();
		let watchCalls = 0;
		const fakeGit: GitPort = {
			isGitRepository: async () => false, // deliberately wrong -- proves the remote-origin shortcut never calls this at all
			status: async () => ({ current: null, files: [], ahead: 0, behind: 0, tracking: null }),
			log: async () => [],
			diff: async () => ({ diff: "", truncated: false }),
			showFile: async () => undefined,
		};
		const fakeFetcher: RepoFetcherPort = {
			fetch: async (): Promise<RepoFetchResult> => ({ path: root, fromCache: false, resolvedRef: "HEAD", refFallbackOccurred: false, commit: "a".repeat(40) }),
			resolveRemoteCommit: async () => undefined,
			listCached: async () => [],
			evict: async () => false,
		};
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: () => stub.index,
			createGitPort: () => fakeGit,
			createRepoFetcher: () => fakeFetcher,
			createFileWatcher: () => ({
				watch: () => {
					watchCalls++;
					return { close: () => {} };
				},
			}),
		});
		const reference: RepoReference = { host: "local-fixture", owner: "acme", repo: "widgets", ref: null };
		const { workspaceId } = await service.dispatch("repo.fetch", reference);

		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		expect(watchCalls).toBe(1);
	});
});

describe("monoglot: one real language's real files, with a real GitPort and a real FileWatcher", () => {
	function buildTypeScriptFixture(): string {
		const dir = tempDir("lector-monoglot-git-required-");
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
		return dir;
	}

	it("a real non-git TypeScript directory never auto-repopulates after a real file change", async () => {
		const root = buildTypeScriptFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const before = stub.documentSymbolsCalls();

		writeFileSync(join(root, "b.ts"), "export const b = 2;\n");

		await neverHappensWithin(() => stub.documentSymbolsCalls() > before, 400);
	});

	it("a real git-initialized TypeScript repository does auto-repopulate after a real file change", async () => {
		const root = buildTypeScriptFixture();
		initGitRepo(root);
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		const before = stub.documentSymbolsCalls();

		writeFileSync(join(root, "b.ts"), "export const b = 2;\n");

		await waitFor(() => stub.documentSymbolsCalls() > before);
	});
});

describe("polyglot: several real languages' real files in one workspace, with a real GitPort and a real FileWatcher", () => {
	function buildPolyglotFixture(): { root: string; tsDir: string; goDir: string; pyDir: string } {
		const root = tempDir("lector-polyglot-git-required-");
		const tsDir = join(root, "frontend");
		mkdirSync(tsDir);
		writeFileSync(join(tsDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
		writeFileSync(join(tsDir, "main.ts"), "export const tsValue = 1;\n");
		const goDir = join(root, "worker");
		mkdirSync(goDir);
		writeFileSync(join(goDir, "go.mod"), "module fixture/worker\n\ngo 1.22\n");
		writeFileSync(join(goDir, "main.go"), "package worker\n\nfunc GoValue() int { return 1 }\n");
		const pyDir = join(root, "backend");
		mkdirSync(pyDir);
		writeFileSync(join(pyDir, "main.py"), "def python_value() -> int:\n    return 1\n");
		return { root, tsDir, goDir, pyDir };
	}

	it("a real non-git polyglot workspace never auto-repopulates after a real change in any of its languages", async () => {
		const { root, tsDir, goDir, pyDir } = buildPolyglotFixture();
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 30, maxSymbolsPerFile: 10 });
		const before = stub.documentSymbolsCalls();

		writeFileSync(join(tsDir, "extra.ts"), "export const extra = 2;\n");
		writeFileSync(join(goDir, "extra.go"), "package worker\n\nfunc Extra() int { return 2 }\n");
		writeFileSync(join(pyDir, "extra.py"), "def extra() -> int:\n    return 2\n");

		await neverHappensWithin(() => stub.documentSymbolsCalls() > before, 400);
	});

	it("a real git-initialized polyglot repository does auto-repopulate after a real change in any of its languages", async () => {
		const { root, tsDir, goDir, pyDir } = buildPolyglotFixture();
		initGitRepo(root);
		const stub = stubIndex();
		service = createLectorService(new Map(), { allowDynamicOnly: true, createSymbolIndex: () => stub.index, graphRefreshDebounceMs: 30 });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 30, maxSymbolsPerFile: 10 });
		const before = stub.documentSymbolsCalls();

		writeFileSync(join(tsDir, "extra.ts"), "export const extra = 2;\n");
		writeFileSync(join(goDir, "extra.go"), "package worker\n\nfunc Extra() int { return 2 }\n");
		writeFileSync(join(pyDir, "extra.py"), "def extra() -> int:\n    return 2\n");

		await waitFor(() => stub.documentSymbolsCalls() > before);
	});
});
