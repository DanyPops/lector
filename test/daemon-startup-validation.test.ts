/**
 * Checklist: "daemon fails loudly on misconfiguration instead of degrading
 * silently" (task f3cdc40f). Locus's LCS-BUG-88 shipped because `locus
 * serve` with no workspace defaulted to cwd (which was `/` in the
 * container) and silently ran forever returning empty results, diagnosed
 * only via a debug endpoint someone had to think to add.
 *
 * Lector's daemon has no implicit workspace to fall back to at all: given
 * zero registered workspaces, it must refuse to start -- no listener bound,
 * no handle file written -- rather than come up and answer every operation
 * with UnknownWorkspace forever.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readDaemonHandle } from "@danypops/daemon-kit/paths";
import { startLectorDaemon } from "../src/daemon.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

describe("startLectorDaemon", () => {
	it("throws synchronously when given zero registered workspaces, before binding a listener", () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanup = cleanupPaths;

		expect(() => startLectorDaemon({ workspaces: new Map(), paths })).toThrow(/at least one registered workspace/);
	});

	it("never writes a daemon handle file when startup is refused", () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanup = cleanupPaths;

		try {
			startLectorDaemon({ workspaces: new Map(), paths });
		} catch {
			// expected -- assert the observable consequence below regardless.
		}

		expect(readDaemonHandle(paths.handle)).toBeNull();
	});

	it("starts normally and writes a real handle once at least one workspace is registered", async () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const { InMemoryWorkspace } = await import("../src/adapters/in-memory-workspace.ts");
		const daemon = startLectorDaemon({ workspaces: new Map([["main", new InMemoryWorkspace()]]), paths });
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};

		const handle = readDaemonHandle(paths.handle);
		expect(handle).not.toBeNull();
		expect(handle?.port).toBe(daemon.port);
	});

	it("starts with zero workspaces when allowDynamicOnly is explicitly set -- the guard requires an explicit opt-in, not silent loosening", () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		const daemon = startLectorDaemon({ workspaces: new Map(), paths, allowDynamicOnly: true });
		cleanup = () => {
			void daemon.stop();
			cleanupPaths();
		};

		expect(readDaemonHandle(paths.handle)).not.toBeNull();
	});

	it("still throws on zero workspaces when allowDynamicOnly is absent, even though the option now exists", () => {
		const { paths, cleanup: cleanupPaths } = isolatedLectorPaths();
		cleanup = cleanupPaths;

		expect(() => startLectorDaemon({ workspaces: new Map(), paths, allowDynamicOnly: false })).toThrow(/at least one registered workspace/);
	});
});
