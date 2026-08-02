/**
 * A project's workspace is registered exactly once and reused. Registration
 * is keyed by each path's *own* nearest git root, never a single fixed
 * session cwd: two files under different repos must resolve to two
 * different workspaces in the very same running session.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLectorClient, type LectorClient, resolveLectorPaths } from "@danypops/lector";
import {
	lectorClient,
	resetLectorClientForTests,
	setLectorClientConnectorForTests,
	setNewWorkspaceObserver,
	withWorkspace,
	workspaceForCodeIntelligencePath,
	workspaceForDirectory,
	workspaceForPath,
	workspaceForPathOrDirectory,
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

describe("workspaceForCodeIntelligencePath prefers a nearer language-specific root marker over the outer .git", () => {
	it("resolves a monorepo TypeScript subproject to its own tsconfig.json directory, not the outer repo root", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const repo = fakeRepo("pi-lector-monorepo-");
		const subproject = join(repo, "packages", "app");
		try {
			mkdirSync(subproject, { recursive: true });
			writeFileSync(join(subproject, "tsconfig.json"), "{}");
			mkdirSync(join(subproject, "src"));

			const resolved = await workspaceForCodeIntelligencePath(join(subproject, "src", "index.ts"));

			expect(resolved.root).toBe(subproject);
			expect(resolved.root).not.toBe(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("falls back to the outer .git when the file's own language has no closer root marker", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const repo = fakeRepo("pi-lector-no-marker-");
		try {
			const deep = join(repo, "scripts");
			mkdirSync(deep);

			const resolved = await workspaceForCodeIntelligencePath(join(deep, "a.sh"));

			expect(resolved.root).toBe(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});
});

describe("workspaceForPathOrDirectory", () => {
	it("resolves a real directory to itself, not its parent -- the exact bug this fixes (previously dirname()'d every path unconditionally)", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const repo = fakeRepo("pi-lector-path-or-dir-");
		const sibling = fakeRepo("pi-lector-path-or-dir-sibling-");
		try {
			const byRepoDirectory = await workspaceForPathOrDirectory(repo);
			const byFileInsideRepo = await workspaceForPath(join(repo, "a.ts"));
			expect(byRepoDirectory.workspaceId).toBe(byFileInsideRepo.workspaceId);
			expect(byRepoDirectory.root).toBe(repo);

			// A sibling's own workspace must stay distinct -- proves this isn't accidentally
			// resolving to some shared broader ancestor.
			const bySibling = await workspaceForPathOrDirectory(sibling);
			expect(bySibling.workspaceId).not.toBe(byRepoDirectory.workspaceId);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(sibling, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("falls back to dirname() for a file path, same as workspaceForCodeIntelligencePath", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const repo = fakeRepo("pi-lector-path-or-dir-file-");
		try {
			const byFile = await workspaceForPathOrDirectory(join(repo, "a.ts"));
			const byCodeIntelligence = await workspaceForCodeIntelligencePath(join(repo, "a.ts"));
			expect(byFile.workspaceId).toBe(byCodeIntelligence.workspaceId);
			expect(byFile.root).toBe(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("falls back to dirname() for a path that does not exist yet (e.g. a file about to be created)", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const repo = fakeRepo("pi-lector-path-or-dir-missing-");
		try {
			const resolved = await workspaceForPathOrDirectory(join(repo, "not-yet-created.ts"));
			expect(resolved.root).toBe(repo);
		} finally {
			rmSync(repo, { recursive: true, force: true });
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

describe("lectorClient.callOnce -- never transparently retries the operation itself", () => {
	// callOnce()'s contract per vehicle-client: on a stale-connection failure it drops the
	// cached client (so the *next* call()/callOnce() reconnects) but never re-runs `operation`
	// itself -- unlike call(), which retries transparently. This is what makes it the right
	// choice for a mutating/non-idempotent Lector operation.
	function fakeConnectionRefused(): LectorClient {
		return {
			call: () => {
				throw new TypeError("fetch failed");
			},
		} as unknown as LectorClient;
	}

	it("fails immediately on a stale connection, without retrying, unlike call()", async () => {
		let connectorCalls = 0;
		setLectorClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(fakeConnectionRefused());
		});

		const client = await lectorClient();
		await expect(client.callOnce("workspace.registerPath", { path: "/tmp" })).rejects.toThrow(TypeError);
		// A single attempt, not two -- the defining difference from call()'s own retry-once policy.
		expect(connectorCalls).toBe(1);
	});

	it("still resets the connection for the next call, even though it didn't retry this one", async () => {
		const daemon = await startIsolatedLectorDaemon();
		let connectorCalls = 0;
		setLectorClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(connectorCalls === 1 ? fakeConnectionRefused() : daemon.client);
		});

		try {
			const client = await lectorClient();
			await expect(client.callOnce("workspace.registerPath", { path: "/tmp" })).rejects.toThrow(TypeError);
			expect(connectorCalls).toBe(1);

			// The failed attempt reset the cached connection, so this second, separate callOnce()
			// reconnects fresh and succeeds -- proving reset-on-failure still works without retry-in-place.
			const result = await client.callOnce("workspace.registerPath", { path: "/tmp" });
			expect(result.workspaceId).toBeDefined();
			expect(connectorCalls).toBe(2);
		} finally {
			await daemon.stop();
		}
	});

	it("does not retry a genuine domain-level error either -- fails immediately, same as call()", async () => {
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
		await expect(client.callOnce("workspace.registerPath", { path: "/tmp" })).rejects.toThrow(/UnknownWorkspace/);
		expect(connectorCalls).toBe(1);
	});
});

describe("workspaceForPath registers via callOnce, not call", () => {
	it("a stale-connection failure during registration is not silently retried, unlike a read operation would be", async () => {
		// Proves the actual production wiring (workspaceForRoot's own internal choice), not just
		// callOnce()'s own generic contract above: if workspaceForRoot still used call() internally,
		// this would transparently retry and resolve instead of rejecting.
		let connectorCalls = 0;
		const fakeConnectionRefused = (): LectorClient =>
			({
				call: () => {
					throw new TypeError("fetch failed");
				},
			}) as unknown as LectorClient;
		setLectorClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(fakeConnectionRefused());
		});

		await expect(workspaceForPath("/tmp/does-not-matter.txt")).rejects.toThrow(TypeError);
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

describe("setNewWorkspaceObserver", () => {
	afterEach(() => {
		setNewWorkspaceObserver(undefined);
	});

	it("fires exactly once for a root's first registration, not on later calls reusing the cached workspaceId", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const repo = fakeRepo("pi-lector-new-workspace-observer-");
		try {
			const observedRoots: string[] = [];
			setNewWorkspaceObserver((root) => observedRoots.push(root));

			await workspaceForPath(join(repo, "a.ts"));
			await workspaceForPath(join(repo, "b.ts"));
			await workspaceForPath(join(repo, "c.ts"));

			expect(observedRoots).toEqual([repo]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("fires once per distinct root, for two different repos touched in the same session", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const repoA = fakeRepo("pi-lector-new-workspace-observer-a-");
		const repoB = fakeRepo("pi-lector-new-workspace-observer-b-");
		try {
			const observedRoots: string[] = [];
			setNewWorkspaceObserver((root) => observedRoots.push(root));

			await workspaceForPath(join(repoA, "a.ts"));
			await workspaceForPath(join(repoB, "b.ts"));

			expect(observedRoots.sort()).toEqual([repoA, repoB].sort());
		} finally {
			rmSync(repoA, { recursive: true, force: true });
			rmSync(repoB, { recursive: true, force: true });
			await daemon.stop();
		}
	});

	it("is a safe no-op when no observer is registered", async () => {
		const daemon = await startIsolatedLectorDaemon();
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
		const repo = fakeRepo("pi-lector-new-workspace-observer-none-");
		try {
			await expect(workspaceForPath(join(repo, "a.ts"))).resolves.toBeDefined();
		} finally {
			rmSync(repo, { recursive: true, force: true });
			await daemon.stop();
		}
	});
});
