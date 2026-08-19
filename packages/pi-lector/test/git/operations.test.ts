/**
 * createLectorGitOperations wraps Lector's read-only git operations
 * (status/log/diff/compareSymbol) over a running daemon. `directory` is
 * required on every call, same convention as find_symbols.
 *
 * status/log/diff dispatch through the daemon's real Vehicle protocol
 * (/vehicle/manifest, /vehicle/invoke -- see vehicle-client.ts), so these
 * tests wire BOTH the legacy LectorClient connector (compareSymbol, and
 * workspace resolution for every action) and the vehicle client connector
 * against the same isolated daemon -- Lector Phase 1 mounts /vehicle/* on
 * the exact same port/token as /api/v1/ops.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLectorGitOperations } from "../../extension/src/git/operations.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { resetLectorVehicleClientForTests, setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
import { startIsolatedLectorDaemon } from "../support/isolated-lector-daemon.ts";

let repoRoot: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
let ctx: ExtensionContext | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
	ctx = undefined;
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd });
}

function buildRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-git-fixture-"));
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "hello\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

function buildRepoWithBranch(): string {
	const root = buildRepo();
	git(root, "checkout", "-qb", "release-4.20");
	writeFileSync(join(root, "a.txt"), "on release-4.20\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "release-4.20 commit");
	git(root, "checkout", "-q", "master");
	return root;
}

/** A real ExtensionContext (invokeVehicleOperation reads sessionManager/cwd/hasUI off it) without loading pi-lector's own actual extension -- git/operations.ts is tested directly here, not through the registered "git" tool. */
async function realExtensionContext(cwd: string): Promise<ExtensionContext> {
	const h = createExtensionHarness(async () => {}, { cwd });
	await h.boot();
	return h.ctx;
}

async function wireDaemon(): Promise<void> {
	const daemon = await startIsolatedLectorDaemon();
	stopDaemon = daemon.stop;
	setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
	setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));
}

describe("Lector-backed git operations", () => {
	it("status reports a real modified file via a running Lector daemon's Vehicle protocol", async () => {
		await wireDaemon();
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "changed\n");
		ctx = await realExtensionContext(repoRoot);

		const ops = createLectorGitOperations();
		const summary = await ops.status(repoRoot, { toolName: "git", toolCallId: "t1", context: ctx });

		expect(summary.files).toContainEqual({ path: "a.txt", indexStatus: " ", workingDirStatus: "M" });
	}, 20_000);

	it("log returns a real commit via a running Lector daemon's Vehicle protocol", async () => {
		await wireDaemon();
		repoRoot = buildRepo();
		ctx = await realExtensionContext(repoRoot);

		const ops = createLectorGitOperations();
		const entries = await ops.log(repoRoot, 10, { toolName: "git", toolCallId: "t2", context: ctx });

		expect(entries.length).toBe(1);
		expect(entries[0]?.message).toBe("initial commit");
	}, 20_000);

	it("diff shows a real uncommitted change via a running Lector daemon's Vehicle protocol", async () => {
		await wireDaemon();
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.txt"), "changed content\n");
		ctx = await realExtensionContext(repoRoot);

		const ops = createLectorGitOperations();
		const result = await ops.diff(repoRoot, undefined, 10_000, { toolName: "git", toolCallId: "t3", context: ctx });

		expect(result.diff).toContain("+changed content");
	}, 20_000);

	it("compareSymbol reports a real unified diff for a symbol changed between two commits, via a running Lector daemon", async () => {
		const daemon = await startIsolatedLectorDaemon();
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		repoRoot = buildRepo();
		writeFileSync(join(repoRoot, "a.ts"), "export function greet() {\n\treturn 'hi';\n}\n");
		git(repoRoot, "add", "a.ts");
		git(repoRoot, "commit", "-q", "-m", "add greet");
		const v1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
		writeFileSync(join(repoRoot, "a.ts"), "export function greet() {\n\treturn 'hello';\n}\n");
		git(repoRoot, "add", "a.ts");
		git(repoRoot, "commit", "-q", "-m", "change greet");
		const v2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();

		const ops = createLectorGitOperations();
		const result = await ops.compareSymbol(repoRoot, "a.ts", "greet", v1, v2, 10_000);

		expect(result.status).toBe("changed");
		expect(result.diff).toContain("-\treturn 'hi';");
		expect(result.diff).toContain("+\treturn 'hello';");
	}, 20_000);

	it("worktreeAdd/worktreeRemove materialize and tear down a real checkout at another ref, reachable by every other tool via its own returned directory", async () => {
		await wireDaemon();
		repoRoot = buildRepoWithBranch();
		ctx = await realExtensionContext(repoRoot);
		const call = { toolName: "git", toolCallId: "t4", context: ctx };

		const ops = createLectorGitOperations();
		const added = await ops.worktreeAdd(repoRoot, "release-4.20", undefined, call);

		expect(added.created).toBe(true);
		expect(added.ref).toBe("release-4.20");
		expect(readFileSync(join(added.path, "a.txt"), "utf8")).toBe("on release-4.20\n");

		// The worktree's own returned path resolves back to the exact same workspace via the same
		// git-root walk every other pi-lector tool already uses -- a second worktreeAdd against it
		// reuses rather than recreates.
		const reused = await ops.worktreeAdd(repoRoot, "release-4.20", undefined, call);
		expect(reused.created).toBe(false);
		expect(reused.path).toBe(added.path);

		const statusOnWorktree = await ops.status(added.path, call);
		expect(typeof statusOnWorktree.current).toBe("string");

		const removed = await ops.worktreeRemove(added.path, call);
		expect(removed.workspaceId).toBeTruthy();
	}, 20_000);

	it("showFile/grep/listFiles/isAncestor answer real cross-branch questions with no checkout, via a running Lector daemon", async () => {
		await wireDaemon();
		repoRoot = buildRepoWithBranch();
		ctx = await realExtensionContext(repoRoot);
		const call = { toolName: "git", toolCallId: "t5", context: ctx };

		const ops = createLectorGitOperations();

		const onMain = await ops.showFile(repoRoot, "master", "a.txt", call);
		expect(onMain).toBe("hello\n");
		const onRelease = await ops.showFile(repoRoot, "release-4.20", "a.txt", call);
		expect(onRelease).toBe("on release-4.20\n");

		const grepResult = await ops.grep(repoRoot, "release-4.20", "release-4.20", undefined, 10, 10_000, call);
		expect(grepResult.matches).toEqual([{ path: "a.txt", line: 1, text: "on release-4.20" }]);

		const listResult = await ops.listFiles(repoRoot, "release-4.20", undefined, 10, call);
		expect(listResult.paths).toEqual(["a.txt"]);

		const masterSha = execFileSync("git", ["rev-parse", "master"], { cwd: repoRoot }).toString().trim();
		const releaseSha = execFileSync("git", ["rev-parse", "release-4.20"], { cwd: repoRoot }).toString().trim();
		expect(await ops.isAncestor(repoRoot, masterSha, releaseSha, call)).toBe(true);
		expect(await ops.isAncestor(repoRoot, releaseSha, masterSha, call)).toBe(false);
	}, 20_000);
});
