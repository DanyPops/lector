/**
 * A project's workspace is registered exactly once and reused. Registration
 * is keyed by each path's *own* nearest git root, never a single fixed
 * session cwd: two files under different repos must resolve to two
 * different workspaces in the very same running session.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLectorClient, type LectorClient, resolveLectorPaths } from "@danypops/lector";
import {
	lectorClient,
	resetLectorClientForTests,
	setLectorClientConnectorForTests,
	withWorkspace,
	workspaceForCodeIntelligencePath,
	workspaceForDirectory,
	workspaceForPath,
} from "../extension/src/lector-client.ts";
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
		const daemon = await startIsolatedLectorDaemon();
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
			const daemon = await startIsolatedLectorDaemon();
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
		const daemon = await startIsolatedLectorDaemon();
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
		const daemon = await startIsolatedLectorDaemon();
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
		const daemon = await startIsolatedLectorDaemon();
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

	it("workspaceForCodeIntelligencePath falls back to the file's own containing directory, never the filesystem root -- every code-intelligence operation spawns a real language server, unlike read/write/edit", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const plainDir = mkdtempSync(join(tmpdir(), "pi-lector-no-git-"));
		try {
			const resolved = await workspaceForCodeIntelligencePath(join(plainDir, "a.py"));
			expect(resolved.root).toBe(plainDir);
			expect(resolved.root).not.toBe("/");
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

describe("lectorClient recovers from a stale cached connection", () => {
	// The real bug this fixes: the daemon binds a new random port on every restart, but
	// lectorClient() previously cached its resolved client forever once connected, so a
	// restart mid-session left every later call pointed at a dead port until the whole
	// extension reloaded. Simulated here via a connector that returns a dead-port-shaped
	// client first, then a real one -- exactly what a daemon restart looks like from here.
	function fakeConnectionRefused(): LectorClient {
		return {
			call: () => {
				throw new TypeError("fetch failed");
			},
		} as unknown as LectorClient;
	}

	it("reconnects and retries once when the cached client's connection is stale, succeeding transparently", async () => {
		const daemon = await startIsolatedLectorDaemon();
		let connectorCalls = 0;
		setLectorClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(connectorCalls === 1 ? fakeConnectionRefused() : daemon.client);
		});

		try {
			const client = await lectorClient();
			const result = await client.call("workspace.registerPath", { path: "/tmp" });

			expect(result.workspaceId).toBeDefined();
			expect(connectorCalls).toBe(2);
		} finally {
			await daemon.stop();
		}
	});

	it("gives up after one retry if the connection stays stale, rather than retrying forever", async () => {
		let connectorCalls = 0;
		setLectorClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(fakeConnectionRefused());
		});

		const client = await lectorClient();
		await expect(client.call("workspace.registerPath", { path: "/tmp" })).rejects.toThrow(TypeError);
		expect(connectorCalls).toBe(2);
	});

	it("does not retry a genuine domain-level error -- fails immediately rather than masking it", async () => {
		let connectorCalls = 0;
		const domainErrorClient: LectorClient = {
			call: () => {
				throw new Error('UnknownWorkspace: no workspace registered under id "x"');
			},
		} as unknown as LectorClient;
		setLectorClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(domainErrorClient);
		});

		const client = await lectorClient();
		await expect(client.call("workspace.registerPath", { path: "/tmp" })).rejects.toThrow(/UnknownWorkspace/);
		expect(connectorCalls).toBe(1);
	});
});

describe("withWorkspace recovers from a stale cached workspaceId", () => {
	// The real bug this fixes: a daemon restart wipes its in-memory workspace registry
	// (registrations are not persisted across restarts by design), but this module's own
	// workspaceIdByRoot cache has no way to know that on its own -- a call through a stale
	// cached id fails with UnknownWorkspace even though nothing about the files on disk
	// changed.
	it("re-registers and retries once on UnknownWorkspace, succeeding transparently", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const repo = fakeRepo("pi-lector-stale-workspace-");
		try {
			let performCalls = 0;
			const result = await withWorkspace(
				() => workspaceForPath(join(repo, "a.ts")),
				async ({ workspaceId }) => {
					performCalls++;
					if (performCalls === 1) throw new Error(`UnknownWorkspace: no workspace registered under id "${workspaceId}"`);
					return workspaceId;
				},
			);

			expect(result).toBeDefined();
			expect(performCalls).toBe(2);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("does not retry a different error -- fails immediately rather than masking it", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const repo = fakeRepo("pi-lector-other-error-");
		try {
			let performCalls = 0;
			await expect(
				withWorkspace(
					() => workspaceForPath(join(repo, "a.ts")),
					async () => {
						performCalls++;
						throw new Error("WorkspaceEntryNotFound: nope");
					},
				),
			).rejects.toThrow(/WorkspaceEntryNotFound/);
			expect(performCalls).toBe(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("gives up after one retry if UnknownWorkspace persists, rather than retrying forever", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const repo = fakeRepo("pi-lector-persistent-stale-");
		try {
			let performCalls = 0;
			await expect(
				withWorkspace(
					() => workspaceForPath(join(repo, "a.ts")),
					async ({ workspaceId }) => {
						performCalls++;
						throw new Error(`UnknownWorkspace: no workspace registered under id "${workspaceId}"`);
					},
				),
			).rejects.toThrow(/UnknownWorkspace/);
			expect(performCalls).toBe(2);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});
});
