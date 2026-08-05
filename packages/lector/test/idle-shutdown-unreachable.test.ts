/**
 * Simulates the exact reported symptom: "Lector daemon is not running" from
 * a client, even though a daemon process is (or recently was) genuinely
 * alive. Reproduces it via the real mechanism -- an idle-shutdown timer
 * removing the handle file -- rather than just asserting on generated
 * config text.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { connectLectorClient } from "../src/client.ts";
import { startLectorDaemon } from "../src/daemon.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

describe("a daemon that idles out", () => {
	it("becomes unreachable with exactly the client-visible error a user would see", async () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const { InMemoryWorkspace } = await import("../src/workspace/in-memory-workspace.ts");
		const daemon = await startLectorDaemon({
			workspaces: new Map([["main", new InMemoryWorkspace()]]),
			paths,
			idleBudgetMs: 20,
			idleTickMs: 5,
		});
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};

		await expect(connectLectorClient({ paths })).resolves.toBeDefined();

		await new Promise((resolve) => setTimeout(resolve, 150));

		await expect(connectLectorClient({ paths })).rejects.toThrow("Lector daemon is not running; start it with `lector serve`");
	});
});
