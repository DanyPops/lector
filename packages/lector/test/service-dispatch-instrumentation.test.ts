/**
 * dispatch()'s own choke-point instrumentation -- the one place every operation is timed and
 * logged regardless of whether it has migrated onto VehicleRegistry (which gets separate
 * metrics middleware entirely; this covers the legacy majority that doesn't: findSymbols,
 * populateSymbolGraph, rawRead, ...). A representative real operation (workspace.registerPath)
 * stands in for "any operation" here since the wrapping is generic over every OperationName.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLectorService, type LectorService } from "../src/service.ts";
import { recordingLogger } from "./support/recording-logger.ts";

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("dispatch() instrumentation", () => {
	it("logs a real operation's own name and a real, sane duration at debug when it completes well under the slow-warn threshold", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-dispatch-instrumentation-"));
		const { logger, calls } = recordingLogger();
		service = createLectorService(new Map(), { allowDynamicOnly: true, logger });

		await service.dispatch("workspace.registerPath", { path: root });

		const completed = calls.find((call) => call.message === "operation completed");
		expect(completed).toBeDefined();
		expect(completed?.level).toBe("debug");
		expect(completed?.fields).toMatchObject({ component: "dispatch", operation: "workspace.registerPath" });
		const durationMs = completed?.fields?.durationMs;
		expect(typeof durationMs).toBe("number");
		expect(durationMs as number).toBeGreaterThanOrEqual(0);
		expect(calls.some((call) => call.message === "slow operation")).toBe(false);
	});

	it("logs at warn instead of debug once duration meets the configured slow-warn threshold, without changing the real result", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-dispatch-instrumentation-slow-"));
		const { logger, calls } = recordingLogger();
		// A threshold of 0ms makes any real operation -- however fast -- trivially "slow" for
		// this test, without needing to inject an artificial delay into a handler.
		service = createLectorService(new Map(), { allowDynamicOnly: true, logger, dispatchSlowWarnThresholdMs: 0 });

		const result = await service.dispatch("workspace.registerPath", { path: root });

		expect(result.created).toBe(true);
		const slow = calls.find((call) => call.message === "slow operation");
		expect(slow).toBeDefined();
		expect(slow?.level).toBe("warn");
		expect(slow?.fields).toMatchObject({ component: "dispatch", operation: "workspace.registerPath" });
		expect(calls.some((call) => call.message === "operation completed")).toBe(false);
	});

	it("logs a failure's own operation name, duration, and error code, then rethrows the exact same error unchanged", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-dispatch-instrumentation-fail-"));
		const { logger, calls } = recordingLogger();
		service = createLectorService(new Map(), { allowDynamicOnly: true, logger });

		const error = await service.dispatch("workspace.gitStatus", { workspaceId: "never-registered" }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("UnknownWorkspace");
		const failed = calls.find((call) => call.message === "operation failed");
		expect(failed).toBeDefined();
		expect(failed?.level).toBe("warn");
		expect(failed?.fields).toMatchObject({ component: "dispatch", operation: "workspace.gitStatus", code: "UnknownWorkspace" });
		expect(typeof failed?.fields?.durationMs).toBe("number");
	});
});
