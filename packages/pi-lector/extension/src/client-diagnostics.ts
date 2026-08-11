import type { RetryingClientDiagnosticEvent } from "@danypops/vehicle-client/daemon-client";

/**
 * Formats one createRetryingClient diagnostic event as a single, compact line -- the same real
 * RCA gap @danypops/vehicle-client's own onEvent hook was added to close: a scrubbed "connector
 * unavailable" error at the tool-call boundary otherwise gives no way to tell, after the fact,
 * whether it was a genuine fresh connect() failure, a circuit-breaker short-circuit (no connect
 * attempted at all), or an in-flight operation's stale-connection retry. Never includes a stack
 * trace -- name and message only, matching this house's other client-diagnostic channels
 * (@danypops/vehicle-client-pi's own client-diagnostics.ts).
 */
/** Never risks Object's default `[object Object]` stringification for a non-Error, non-string throw. */
function describeError(error: unknown): { name: string; message: string } {
	if (error instanceof Error) return { name: error.name, message: error.message };
	if (typeof error === "string") return { name: "string", message: error };
	if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return { name: typeof error, message: String(error) };
	return { name: typeof error, message: "(unprintable value)" };
}

export function formatClientDiagnosticEvent(event: RetryingClientDiagnosticEvent): string {
	const parts = [`[lector-client] ${event.type}`];
	if (event.attempt !== undefined) parts.push(`attempt=${event.attempt}`);
	if (event.consecutiveFailures !== undefined) parts.push(`consecutiveFailures=${event.consecutiveFailures}`);
	if (event.operationId !== undefined) parts.push(`operationId=${event.operationId}`);
	if (event.error !== undefined) {
		const { name, message } = describeError(event.error);
		parts.push(`error=${name}: ${message}`);
	}
	return parts.join(" ");
}

/**
 * Logs a createRetryingClient diagnostic event to stderr, only when LECTOR_CLIENT_DIAG is set --
 * zero cost and zero output for every session that never opts in, matching the env-gated
 * convention @danypops/vehicle-client-pi's own VEHICLE_CLIENT_DIAG already established in this
 * house. Never throws: onEvent's own contract requires it stay side-effect-light, and a broken
 * local console (or a formatting bug) must not take down a real client call.
 */
export function logClientDiagnosticEvent(event: RetryingClientDiagnosticEvent): void {
	if (!process.env.LECTOR_CLIENT_DIAG) return;
	try {
		console.error(formatClientDiagnosticEvent(event));
	} catch {
		// best-effort only -- see doc comment above.
	}
}
