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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
