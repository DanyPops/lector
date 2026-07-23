/**
 * Checklist (task ef213eb1, revised after a real, shipped bug fix): a
 * project's workspace is registered exactly once and reused, but --
 * unlike the original version of this test suite -- registration is keyed
 * by each path's *own* nearest git root, never a single fixed session cwd.
 * Two files under different repos must resolve to two different
 * workspaces in the very same running session.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { connectLectorClient, resolveLectorPaths, type LectorClient } from "@danypops/lector";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests, setLectorClientConnectorForTests, workspaceForDirectory, workspaceForPath } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

afterEach(() => {
	resetLectorClientForTests();
});

function fakeRepo(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(root, ".git"));
	return root;
}

describe("workspaceForPath", () => {
	it("registers a distinct project root exactly once, even across many calls for different files in it", async () => {
		const daemon = startIsolatedLectorDaemon();
		let registerCalls = 0;
		const countingClient: LectorClient = {
			...daemon.client,
			call: (operation, input) => {
				if (operation === "workspace.registerPath") registerCalls++;
				return daemon.client.call(operation, input);
			},
		} as LectorClient;
		setLectorClientConnectorForTests(() => Promise.resolve(countingClient));

		const repo = fakeRepo("pi-lector-project-");
		try {
			await workspaceForPath(join(repo, "a.ts"));
			await workspaceForPath(join(repo, "src", "b.ts"));
			await workspaceForPath(join(repo, "a.ts"));

			expect(registerCalls).toBe(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it(
		"two files under two different repos resolve to two different workspaces in the same running session -- " +
			"the exact shape of the bug this fixes (previously hard-locked to one session-wide cwd)",
		async () => {
			const daemon = startIsolatedLectorDaemon();
			setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

			const repoA = fakeRepo("pi-lector-repo-a-");
			const repoB = fakeRepo("pi-lector-repo-b-");
			try {
				const resolvedA = await workspaceForPath(join(repoA, "a.ts"));
				const resolvedB = await workspaceForPath(join(repoB, "b.ts"));

				expect(resolvedA.workspaceId).not.toBe(resolvedB.workspaceId);
				expect(resolvedA.root).toBe(repoA);
				expect(resolvedB.root).toBe(repoB);
			} finally {
				rmSync(repoA, { recursive: true, force: true });
				rmSync(repoB, { recursive: true, force: true });
				await daemon.stop();
			}
		},
	);
});

describe("workspaceForDirectory", () => {
	it("resolves a directory to the same workspace as a file inside it via workspaceForPath", async () => {
		const daemon = startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const repo = fakeRepo("pi-lector-dir-");
		try {
			const byFile = await workspaceForPath(join(repo, "a.ts"));
			const byDirectory = await workspaceForDirectory(repo);
			expect(byDirectory.workspaceId).toBe(byFile.workspaceId);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});
});

describe("workspaceForPath vs. workspaceForDirectory fallback when no git repo is found", () => {
	it("workspaceForPath falls back to the filesystem root -- any absolute path is fair game for read/write/edit", async () => {
		const daemon = startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const plainDir = mkdtempSync(join(tmpdir(), "pi-lector-no-git-"));
		try {
			const resolved = await workspaceForPath(join(plainDir, "a.txt"));
			expect(resolved.root).toBe("/");
		} finally {
			rmSync(plainDir, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("workspaceForDirectory falls back to the directory itself, never the filesystem root -- a symbol query must not widen to the whole disk", async () => {
		const daemon = startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const plainDir = mkdtempSync(join(tmpdir(), "pi-lector-no-git-"));
		try {
			const resolved = await workspaceForDirectory(plainDir);
			expect(resolved.root).toBe(plainDir);
		} finally {
			rmSync(plainDir, { recursive: true, force: true });
			await daemon.stop();
		}
	});
});

describe("lectorClient with no daemon reachable", () => {
	it("fails with a clear error naming `lector serve`, never hangs or silently bypasses Lector", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lector-no-daemon-"));
		const paths = resolveLectorPaths({
			env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
		});
		setLectorClientConnectorForTests(() => connectLectorClient({ paths }));

		try {
			await expect(workspaceForPath("/tmp/does-not-matter.txt")).rejects.toThrow(/lector serve/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
