/**
 * Runs a scripted, real `pi` process with the real pi-lector extension loaded against a real
 * isolated Lector daemon, and captures its own real AgentSessionEvent stream -- the trace shape
 * `@danypops/pi-eval-harness`'s matching/rollup logic scores directly, no Lector-specific
 * projection needed (see LectorAgentTrace's own doc comment for why).
 *
 * Malformed or unrecognized events cannot crash capture: pi-process-harness's own line parser
 * (parseRpcLine) silently drops an unparseable line before it ever reaches an event listener,
 * and every consumer of the captured trace (pi-eval-harness's extractToolExecutions/deriveTurns)
 * already ignores an event type it doesn't recognize rather than throwing.
 */
import { fileURLToPath } from "node:url";
import {
	encodeFauxScript,
	type FauxScriptStep,
	resolveFauxProviderExtensionPath,
	SCRIPT_ENV_VAR,
	spawnRealPiProcess,
	waitForRpcEvent,
} from "@danypops/pi-process-harness";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * One real captured Pi agent session's event stream, scripted against Lector's own tools.
 * Identical to pi-eval-harness's own `readonly AgentSessionEvent[]` input on purpose: pi-eval-
 * harness's matching/rollup logic already operates directly on this real event union, so there
 * is no Lector-specific trace format to define or keep in sync -- naming the alias here is
 * purely so call sites read as "a Lector eval trace", not a reimplementation of the type.
 */
export type LectorAgentTrace = readonly AgentSessionEvent[];

const PI_LECTOR_EXTENSION_PATH = fileURLToPath(new URL("../../extension/src/index.ts", import.meta.url));

export interface CaptureLectorAgentTraceOptions {
	/** XDG env overrides pointing at the isolated Lector daemon this scripted run must connect to -- see startIsolatedLectorDaemon's own returned `env`. */
	readonly daemonEnv: Record<string, string>;
	/** The scripted tool call(s)/text step(s) the faux provider plays back -- no live LLM call. */
	readonly script: readonly FauxScriptStep[];
	readonly cwd?: string;
	/** How long to wait for the scripted tool call(s) to finish. Default 20s. */
	readonly timeoutMs?: number;
}

/** Spawns the scripted run, waits for its last scripted tool call to complete, and returns every event observed. */
export async function captureLectorAgentTrace(options: CaptureLectorAgentTraceOptions): Promise<LectorAgentTrace> {
	const proc = spawnRealPiProcess({
		extensions: [resolveFauxProviderExtensionPath(), PI_LECTOR_EXTENSION_PATH],
		extraArgs: ["--provider", "faux", "--model", "faux-1"],
		...(options.cwd !== undefined && { cwd: options.cwd }),
		env: { ...options.daemonEnv, [SCRIPT_ENV_VAR]: encodeFauxScript(options.script) },
	});

	const events: AgentSessionEvent[] = [];
	proc.onEvent((event) => events.push(event));
	proc.sendPrompt("go");

	try {
		await waitForRpcEvent(events, (event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end", {
			timeoutMs: options.timeoutMs ?? 20_000,
		});
	} finally {
		await proc.dispose();
	}

	return events;
}
