/**
 * Regression coverage for a real production incident: after installing a new pi-lector while the
 * previously-running Lector daemon was still an older version that predated workspace.listDirectory,
 * opening /editor with no path crashed the whole Pi process with an uncaught exception -- an
 * unhandled promise rejection escaping ExplorerComponent's fire-and-forget initial load.
 *
 * Reproduces the exact real command path (registerCommand("editor") -> ui.custom ->
 * ExplorerComponent's constructor) via @danypops/pi-extension-harness, the shared in-process
 * extension test host, rather than unit-testing ExplorerComponent in isolation (already covered
 * by explorer-component.test.ts) -- this proves the wiring at the actual boundary a user hits,
 * not just the component's own internal behavior. The "stale daemon" is a real, tiny local HTTP
 * server that genuinely does not know workspace.listDirectory, matching the real incident's own
 * error string -- connectLectorClientAt then talks to it exactly as it would a real daemon.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLectorClientAt } from "@danypops/lector";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import lectorExtension from "../../extension/src/index.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";

let repoRoot: string | undefined;
let stopStaleDaemon: (() => void) | undefined;

afterEach(() => {
	resetLectorClientForTests();
	stopStaleDaemon?.();
	stopStaleDaemon = undefined;
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
	repoRoot = undefined;
});

function fakeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-explorer-crash-safety-"));
	mkdirSync(join(root, ".git"));
	return root;
}

/** A real local HTTP server standing in for a daemon that predates workspace.listDirectory -- registerPath still works (an old daemon knows it), listDirectory does not, matching the real incident's exact error string. */
function startStaleDaemon(): { baseUrl: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const { op } = (await request.json()) as { op: string };
			if (op === "workspace.registerPath") {
				return new Response(JSON.stringify({ result: { workspaceId: "fake-ws", created: true } }), { status: 200 });
			}
			return new Response(JSON.stringify({ error: `unknown operation: ${op}` }), { status: 400 });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Overrides the harness's default ui.custom (which never invokes its factory) to actually
 * construct the real Component, matching what a live Pi TUI does. Real ui.custom only resolves
 * once the component calls its own done() callback (the user closes the explorer) -- never
 * invoked in this test, so the returned promise deliberately never settles, exactly like the
 * real overlay would stay open while the crash happens in the background.
 */
function driveRealUiCustom(ctx: ExtensionContext): void {
	(ctx.ui as { custom: ExtensionUIContext["custom"] }).custom = ((factory: any) => {
		const tui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
		const theme = { fg: (_color: string, text: string) => text };
		factory(tui, theme, {}, () => undefined);
		return new Promise(() => undefined);
	}) as ExtensionUIContext["custom"];
}

describe("/editor with no path -- crash safety against a daemon that rejects a real operation", () => {
	it("never lets a daemon RPC failure escape as an unhandled rejection that would crash the whole Pi process", async () => {
		repoRoot = fakeRepo();
		const staleDaemon = startStaleDaemon();
		stopStaleDaemon = staleDaemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(connectLectorClientAt(staleDaemon.baseUrl, "fake-token")));

		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const h = createExtensionHarness(lectorExtension, { cwd: repoRoot });
			driveRealUiCustom(h.ctx);
			await h.boot();

			// The command's own overlay never resolves (see driveRealUiCustom) -- fire it without
			// awaiting, exactly like a real Pi TUI does while the explorer stays open, then give the
			// constructor's initial load (a real HTTP round trip to the stale daemon) a bounded window
			// to reject before asserting on the outcome.
			void h.invokeCommand("editor", "");
			await new Promise((resolve) => setTimeout(resolve, 200));

			await h.shutdown();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandledRejections).toEqual([]);
	});
});
