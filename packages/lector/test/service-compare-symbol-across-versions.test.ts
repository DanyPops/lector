/**
 * Service-level wiring for workspace.compareSymbolAcrossVersions -- real git commits, real
 * tree-sitter extraction, no LSP/checkout involved (the syntactic tier this operation's own
 * first pass targets; see the task's own two-tier rationale).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService, NotAGitRepository, SymbolComparisonUnsupportedLanguage, UnknownWorkspace } from "../src/service.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-compare-symbol-"));
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@t.com");
	git(dir, "config", "user.name", "t");
	return dir;
}

describe("createLectorService's workspace.compareSymbolAcrossVersions", () => {
	it("reports 'changed' with a real unified diff when a function's own body differs between two commits", async () => {
		root = buildRepo();
		writeFileSync(join(root, "a.ts"), "export function greet() {\n\treturn 'hi';\n}\n");
		git(root, "add", "a.ts");
		git(root, "commit", "-q", "-m", "v1");
		const v1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

		writeFileSync(join(root, "a.ts"), "export function greet() {\n\treturn 'hello';\n}\n");
		git(root, "add", "a.ts");
		git(root, "commit", "-q", "-m", "v2");
		const v2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.compareSymbolAcrossVersions", {
			workspaceId,
			path: "a.ts",
			symbolName: "greet",
			fromRef: v1,
			toRef: v2,
			maxBytes: 10_000,
		});

		expect(result.status).toBe("changed");
		expect(result.diff).toContain("-\treturn 'hi';");
		expect(result.diff).toContain("+\treturn 'hello';");
		expect(result.truncated).toBe(false);
	});

	it("compares a commit against the current working tree when toRef is omitted", async () => {
		root = buildRepo();
		writeFileSync(join(root, "a.ts"), "export function greet() {\n\treturn 'hi';\n}\n");
		git(root, "add", "a.ts");
		git(root, "commit", "-q", "-m", "v1");
		const v1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

		writeFileSync(join(root, "a.ts"), "export function greet() {\n\treturn 'uncommitted';\n}\n");

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.compareSymbolAcrossVersions", {
			workspaceId,
			path: "a.ts",
			symbolName: "greet",
			fromRef: v1,
			maxBytes: 10_000,
		});

		expect(result.status).toBe("changed");
		expect(result.toRef).toBe("working tree");
		expect(result.diff).toContain("+\treturn 'uncommitted';");
	});

	it("reports 'added' when the symbol exists only at the newer version", async () => {
		root = buildRepo();
		writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
		git(root, "add", "a.ts");
		git(root, "commit", "-q", "-m", "v1");
		const v1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

		writeFileSync(join(root, "a.ts"), "export const x = 1;\nexport function brandNew() {}\n");
		git(root, "add", "a.ts");
		git(root, "commit", "-q", "-m", "v2");
		const v2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.compareSymbolAcrossVersions", {
			workspaceId,
			path: "a.ts",
			symbolName: "brandNew",
			fromRef: v1,
			toRef: v2,
			maxBytes: 10_000,
		});

		expect(result.status).toBe("added");
	});

	it("rejects an unsupported file extension before touching git or tree-sitter", async () => {
		// .rs has no registered tree-sitter grammar in wasmPathForExtension -- distinct from .py,
		// which gained real tree-sitter support and so is no longer a valid "unsupported" example.
		root = buildRepo();
		writeFileSync(join(root, "a.rs"), 'fn greet() -> &\'static str {\n\t"hi"\n}\n');
		git(root, "add", "a.rs");
		git(root, "commit", "-q", "-m", "v1");
		const v1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await expect(
			service.dispatch("workspace.compareSymbolAcrossVersions", { workspaceId, path: "a.rs", symbolName: "greet", fromRef: v1, maxBytes: 10_000 }),
		).rejects.toBeInstanceOf(SymbolComparisonUnsupportedLanguage);
	});

	it("compares a real Python symbol's own declaration text across two committed versions -- newly supported now that .py has a registered tree-sitter grammar", async () => {
		root = buildRepo();
		writeFileSync(join(root, "a.py"), "def greet():\n    return 'hi'\n");
		git(root, "add", "a.py");
		git(root, "commit", "-q", "-m", "v1");
		const v1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
		writeFileSync(join(root, "a.py"), "def greet():\n    return 'hello'\n");
		git(root, "add", "a.py");
		git(root, "commit", "-q", "-m", "v2");

		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const result = await service.dispatch("workspace.compareSymbolAcrossVersions", {
			workspaceId,
			path: "a.py",
			symbolName: "greet",
			fromRef: v1,
			maxBytes: 10_000,
		});

		expect(result.status).toBe("changed");
		expect(result.diff).toContain("'hi'");
		expect(result.diff).toContain("'hello'");
	});

	it("rejects NotAGitRepository for a plain (non-git) registered workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-compare-symbol-plain-"));
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		await expect(
			service.dispatch("workspace.compareSymbolAcrossVersions", { workspaceId, path: "a.ts", symbolName: "x", fromRef: "HEAD", maxBytes: 10_000 }),
		).rejects.toBeInstanceOf(NotAGitRepository);
	});

	it("rejects an unknown workspaceId before ever touching git", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(
			service.dispatch("workspace.compareSymbolAcrossVersions", {
				workspaceId: "never-registered",
				path: "a.ts",
				symbolName: "x",
				fromRef: "HEAD",
				maxBytes: 10_000,
			}),
		).rejects.toBeInstanceOf(UnknownWorkspace);
	});
});
