import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { RetryingClientDiagnosticEvent } from "@danypops/vehicle-client/daemon-client";
import { formatClientDiagnosticEvent, logClientDiagnosticEvent } from "../extension/src/client-diagnostics.ts";

describe("formatClientDiagnosticEvent", () => {
	it("formats a bare event with only its type", () => {
		expect(formatClientDiagnosticEvent({ type: "connect-success" })).toBe("[lector-client] connect-success");
	});

	it("includes attempt, consecutiveFailures, and operationId when present", () => {
		const event: RetryingClientDiagnosticEvent = { type: "breaker-open-short-circuit", attempt: 1, consecutiveFailures: 3, operationId: "op-1" };
		expect(formatClientDiagnosticEvent(event)).toBe("[lector-client] breaker-open-short-circuit attempt=1 consecutiveFailures=3 operationId=op-1");
	});

	it("includes a real Error's own name and message, never its stack", () => {
		const error = new TypeError("boom");
		const line = formatClientDiagnosticEvent({ type: "connect-failure", error });
		expect(line).toBe("[lector-client] connect-failure error=TypeError: boom");
		expect(line).not.toContain("at ");
	});

	it("stringifies a non-Error thrown value by its typeof, not by crashing", () => {
		expect(formatClientDiagnosticEvent({ type: "stale-connection-retry", error: "raw string failure" })).toBe(
			"[lector-client] stale-connection-retry error=string: raw string failure",
		);
	});

	it("never renders Object's own default '[object Object]' stringification for a thrown plain object", () => {
		expect(formatClientDiagnosticEvent({ type: "connect-failure", error: { some: "shape" } })).toBe(
			"[lector-client] connect-failure error=object: (unprintable value)",
		);
	});
});

describe("logClientDiagnosticEvent", () => {
	let previousEnv: string | undefined;
	let errorSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		previousEnv = process.env.LECTOR_CLIENT_DIAG;
		errorSpy = mock(() => {});
		console.error = errorSpy;
	});

	afterEach(() => {
		if (previousEnv === undefined) delete process.env.LECTOR_CLIENT_DIAG;
		else process.env.LECTOR_CLIENT_DIAG = previousEnv;
	});

	it("is a silent no-op when LECTOR_CLIENT_DIAG is unset -- zero cost for every session that never opts in", () => {
		delete process.env.LECTOR_CLIENT_DIAG;
		logClientDiagnosticEvent({ type: "connect-success" });
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("logs to console.error when LECTOR_CLIENT_DIAG is set", () => {
		process.env.LECTOR_CLIENT_DIAG = "1";
		logClientDiagnosticEvent({ type: "pre-dispatch-retry", attempt: 0 });
		expect(errorSpy).toHaveBeenCalledWith("[lector-client] pre-dispatch-retry attempt=0");
	});

	it("never throws, even if console.error itself throws -- onEvent's own contract requires this stay side-effect-light", () => {
		process.env.LECTOR_CLIENT_DIAG = "1";
		console.error = () => {
			throw new Error("console is broken");
		};
		expect(() => logClientDiagnosticEvent({ type: "mutation-outcome-unknown" })).not.toThrow();
	});
});
