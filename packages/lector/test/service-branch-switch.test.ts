/**
 * What actually happens when the working tree underneath a registered workspace is switched to a
 * different git branch entirely -- not just "HEAD moved via a new commit on the same branch"
 * (already covered by service-git-cache-freshness.test.ts), but a real `git checkout` swapping in
 * a different file's own content wholesale, exactly like a user working on the same local clone
 * across branches while Lector still has it registered, cached, and possibly warm.
 *
 * Four real, separately-verified questions:
 * 1. Does workspace.cacheStatus's git-based fast path correctly detect the branch switch as
 *    staleness (not just "same branch, new commit")?
 * 2. Does an already-warm LSP index (typescript-language-server) serve the OLD branch's symbols
 *    after the switch, or pick up the new branch's real content?
 * 3. Does a mutation-history entry recorded before the switch still (wrongly) allow reverting
 *    into content that predates a branch that was never edited via Lector at all?
 * 4. Does a CROSS-FILE query still resolve correctly when the target file (as opposed to the
 *    file the query itself was issued against) is never individually re-opened/re-queried by
 *    Lector after the switch -- the case that depends on tsserver's own project-wide file
 *    watching picking up the change, not Lector's own ensureFileOpen fresh-read-and-compare
 *    (question 2's own mechanism, which only ever applies to a file Lector itself explicitly
 *    reads and opens).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

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

function writeMathFile(dir: string, exportedName: string): void {
	writeFileSync(join(dir, "math.ts"), `export function ${exportedName}(a: number, b: number): number {\n\treturn a + b;\n}\n`);
}

/** Two real branches, each with math.ts exporting a DIFFERENT, non-overlapping name -- "main" exports "add", "feature" exports "subtract". */
function buildTwoBranchFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-branch-switch-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t.com");
	git(dir, "config", "user.name", "t");
	writeMathFile(dir, "add");
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "main: add");
	git(dir, "checkout", "-q", "-b", "feature");
	writeMathFile(dir, "subtract");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "feature: subtract");
	git(dir, "checkout", "-q", "main"); // start on main -- tree clean
	return dir;
}

function buildService(): LectorService {
	return createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
	});
}

/**
 * Two branches, two cross-referencing files: math.ts exports the function, consumer.ts imports
 * and calls it -- on "main" the export is named "add", on "feature" it's renamed to "sum" (and
 * consumer.ts's own call site renamed to match, exactly like a real rename landing on a branch).
 */
function buildCrossFileTwoBranchFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "lector-branch-switch-cross-file-"));
	const writeFiles = (exportedName: string): void => {
		writeFileSync(join(dir, "math.ts"), `export function ${exportedName}(a: number, b: number): number {\n\treturn a + b;\n}\n`);
		writeFileSync(
			join(dir, "consumer.ts"),
			`import { ${exportedName} } from "./math";\n\nexport function total(): number {\n\treturn ${exportedName}(1, 2);\n}\n`,
		);
	};
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t.com");
	git(dir, "config", "user.name", "t");
	writeFiles("add");
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["."] }));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "main: add");
	git(dir, "checkout", "-q", "-b", "feature");
	writeFiles("sum");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "feature: renamed add to sum");
	git(dir, "checkout", "-q", "main");
	return dir;
}

describe("a real branch switch underneath a registered workspace", () => {
	it("cacheStatus's git-based fast path correctly detects a branch switch as staleness, not just a same-branch commit", async () => {
		root = buildTwoBranchFixture();
		service = buildService();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		await service.dispatch("workspace.populateSymbolGraph", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });

		const beforeSwitch = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(beforeSwitch.status).toBe("cached");

		git(root, "checkout", "-q", "feature"); // real branch switch, clean tree on both sides

		const afterSwitch = await service.dispatch("workspace.cacheStatus", { workspaceId, maxFiles: 10, maxSymbolsPerFile: 10 });
		expect(afterSwitch.status).toBe("not-cached");
		expect(afterSwitch.status === "not-cached" && afterSwitch.reason).toBe("source-changed");
	});

	it("an already-warm LSP index picks up the new branch's real content on the next query -- not stale symbols from the branch it was warmed against", async () => {
		root = buildTwoBranchFixture();
		service = buildService();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		// Warms the LSP index against "main"'s own content -- confirms "add" is what's really there.
		const onMain = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add" });
		expect(onMain.symbols.some((symbol) => symbol.name === "add")).toBe(true);

		git(root, "checkout", "-q", "feature"); // real branch switch, no Lector call in between

		// Same already-warm index, same file path, queried again with no re-registration or
		// explicit invalidation -- does it serve "feature"'s real content or "main"'s stale one?
		const onFeature = await service.dispatch("workspace.findSymbols", { workspaceId, query: "subtract" });
		expect(onFeature.symbols.some((symbol) => symbol.name === "subtract")).toBe(true);

		const staleCheck = await service.dispatch("workspace.findSymbols", { workspaceId, query: "add" });
		expect(staleCheck.symbols.some((symbol) => symbol.name === "add")).toBe(false);
	}, 20_000);

	it("a mutation-history entry recorded before the switch correctly refuses to revert once the branch switch has changed the file's real content", async () => {
		root = buildTwoBranchFixture();
		service = buildService();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });

		const before = await service.dispatch("workspace.rawRead", { workspaceId, path: "math.ts" });
		const edited = await service.dispatch("workspace.exactEdit", {
			workspaceId,
			path: "math.ts",
			expectedHash: before.hash,
			content: "export function add(a: number, b: number): number {\n\treturn a - b; // a real bug, recorded as a mutation-history entry\n}\n",
		});
		const history = await service.dispatch("workspace.mutationHistory", { workspaceId, path: "math.ts", maxResults: 5 });
		const entry = history.entries.find((candidate) => candidate.afterHash === edited.newHash);
		if (!entry) throw new Error("expected the exactEdit above to have recorded its own mutation-history entry");

		git(root, "checkout", "--", "math.ts"); // discards the uncommitted exactEdit, back to "main"'s committed content
		git(root, "checkout", "-q", "feature"); // then a real branch switch on top of that

		// The entry's own afterHash no longer matches what's on disk (now "feature"'s content, not
		// even the exactEdit's own result) -- canRevertMutation's plain content-hash guard refuses,
		// exactly the same as it would for a change from any other source, git or not.
		await expect(service.dispatch("workspace.revertMutation", { workspaceId, entryId: entry.id })).rejects.toThrow();
	}, 20_000);

	it("a cross-file goToDefinition resolves against the new branch's real content even though the TARGET file (math.ts) is never itself individually re-opened or re-queried by Lector after the switch", async () => {
		// Isolates a different mechanism than test 2 above: that test re-queried the SAME file that
		// changed, exercising Lector's own ensureFileOpen fresh-read-and-compare. Here, the only
		// Lector call after the switch targets consumer.ts (the query's own source position) --
		// math.ts (the goToDefinition target) is never itself named in any Lector call, so a stale
		// result here could only be explained by tsserver's own project-wide model going stale, not
		// by anything Lector itself failed to refresh.
		root = buildCrossFileTwoBranchFixture();
		service = buildService();
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
		const consumerPath = join(root, "consumer.ts");
		const mathPath = join(root, "math.ts");

		// Warms the project on "main": consumer.ts's own call to add(1, 2) resolves to math.ts's real
		// declaration -- confirms tsserver has both files loaded and cross-referenced before the switch.
		const onMain = await service.dispatch("workspace.goToDefinition", { workspaceId, path: consumerPath, line: 4, character: 9 });
		expect(onMain.locations.some((location) => location.path === mathPath)).toBe(true);

		git(root, "checkout", "-q", "feature"); // real branch switch -- both files change on disk

		// Only consumer.ts is named in this call (the query's own source position). math.ts is never
		// itself touched by any Lector call in this test after the switch -- if tsserver's own
		// project-wide file watching didn't pick up the change, "sum" would not exist anywhere in
		// its stale (still "add"-only) understanding of math.ts, and this would resolve to nothing at
		// all, not merely a wrong location -- so the specific declaration line matters, not just the
		// file path.
		const onFeature = await service.dispatch("workspace.goToDefinition", { workspaceId, path: consumerPath, line: 4, character: 9 });
		expect(onFeature.locations.some((location) => location.path === mathPath && location.line === 1 && location.character === 17)).toBe(true);

		const definitionSymbols = await service.dispatch("workspace.documentSymbols", { workspaceId, path: mathPath });
		expect(definitionSymbols.symbols.some((symbol) => symbol.name === "sum")).toBe(true);
		expect(definitionSymbols.symbols.some((symbol) => symbol.name === "add")).toBe(false);
	}, 20_000);
});
