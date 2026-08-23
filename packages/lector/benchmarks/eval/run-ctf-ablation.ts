#!/usr/bin/env bun
/**
 * The real A/B benchmark: for every CTF_CORPUS task, runs N real live-LLM trials under two
 * arms -- "baseline" (a genuinely isolated `pi` process with only the real Anthropic-via-Vertex
 * provider extension, no other tools beyond Pi's own built-ins) vs "with-lector" (the same,
 * plus the real pi-lector extension registered against a real isolated Lector daemon) -- and
 * reports tool-call/token/turn/mistake deltas via pi-eval-harness's own ablate()/formatAblation().
 *
 * Never run automatically: real, billed API calls. Run explicitly:
 *   bun benchmarks/eval/run-ctf-ablation.ts [corpusKey] [trialsPerArm]
 * corpusKey defaults to "small:typescript" -- see ctf-corpus-registry.ts's own CTF_CORPORA for
 * every other registered "tier:language" key.
 *
 * Baseline isolation is deliberate: the operator's own real ~/.pi/agent profile has pi-lector
 * installed (this whole session runs through it) -- isolatedHome: false would silently give the
 * "baseline" arm Lector's tools too, invalidating the whole comparison. The vertex provider is a
 * real npm package (@twogiants/pi-anthropic-vertex), not a built-in Pi provider, so it has to be
 * passed as an explicit extension even under a genuinely isolated home.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawnRealPiProcess, waitForRpcEvent } from "@danypops/pi-process-harness";
import {
	ablate,
	type AblationConfig,
	deriveTurns,
	extractToolExecutions,
	formatAblation,
	summarizeRunUsage,
	type TrialResult,
} from "@danypops/pi-eval-harness";
import { InMemoryWorkspace, resolveLectorPaths, startLectorDaemon } from "../../src/index.ts";
import type { CtfFixtureHandle, CtfTask } from "./ctf-corpus-registry.ts";
import { resolveCtfCorpus } from "./ctf-corpus-registry.ts";

const VERTEX_PROVIDER_EXTENSION = join(homedir(), ".pi/agent/npm/node_modules/@twogiants/pi-anthropic-vertex/index.ts");
const PI_LECTOR_EXTENSION_PATH = fileURLToPath(new URL("../../../pi-lector/extension/src/index.ts", import.meta.url));
const TRIAL_TIMEOUT_MS = 180_000;

async function startIsolatedDaemon(): Promise<{ env: Record<string, string>; stop: () => Promise<void> }> {
	const root = mkdtempSync(join(tmpdir(), "lector-ctf-ablation-daemon-"));
	const env = { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root };
	const paths = resolveLectorPaths({ env });
	const daemon = await startLectorDaemon({ workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]), paths });
	return {
		env,
		stop: async () => {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function runOneTrial(
	task: CtfTask,
	materializeFixture: () => CtfFixtureHandle,
	extensions: readonly string[],
	extraEnv: Record<string, string>,
): Promise<TrialResult> {
	const fixture = materializeFixture();
	const start = Date.now();

	const proc = spawnRealPiProcess({
		extensions: [VERTEX_PROVIDER_EXTENSION, ...extensions],
		extraArgs: ["--provider", "anthropic-vertex", "--model", "claude-sonnet-5"],
		cwd: fixture.root,
		env: { GOOGLE_APPLICATION_CREDENTIALS: join(homedir(), ".config/gcloud/application_default_credentials.json"), ...extraEnv },
	});

	const events: AgentSessionEvent[] = [];
	proc.onEvent((event) => events.push(event));
	proc.sendPrompt(task.prompt);

	try {
		await waitForRpcEvent(events, (event): event is Extract<AgentSessionEvent, { type: "agent_end" }> => event.type === "agent_end", {
			timeoutMs: TRIAL_TIMEOUT_MS,
		});
	} catch (error) {
		const durationMs = Date.now() - start;
		await proc.dispose();
		fixture.dispose();
		return {
			pass: false,
			score: 0,
			durationMs,
			tokensIn: 0,
			tokensOut: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	await proc.dispose();

	const durationMs = Date.now() - start;
	const turns = deriveTurns(events);
	const usage = summarizeRunUsage(turns);
	const executions = extractToolExecutions(events);
	const checkerResult = await task.checker.check({ executions, workspace: fixture.root });
	fixture.dispose();

	return {
		pass: checkerResult.pass,
		score: checkerResult.score,
		durationMs,
		tokensIn: usage.tokensIn,
		tokensOut: usage.tokensOut,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		costUsd: usage.costUsd,
	};
}

async function main(): Promise<void> {
	const corpusKey = process.argv[2] ?? "small:typescript";
	const trialsPerArm = Number(process.argv[3] ?? "1");
	const corpus = resolveCtfCorpus(corpusKey);
	console.log(`Running the real CTF ablation benchmark (${corpusKey}): ${corpus.tasks.length} tasks x 2 arms x ${trialsPerArm} trial(s) each.\n`);

	const daemon = await startIsolatedDaemon();
	const report: string[] = [];

	try {
		for (const task of corpus.tasks) {
			console.log(`=== ${task.id} (${task.category}) ===`);
			const configs: AblationConfig[] = [
				{ name: "baseline", runOne: () => runOneTrial(task, corpus.materializeFixture, [], {}) },
				{ name: "with-lector", runOne: () => runOneTrial(task, corpus.materializeFixture, [PI_LECTOR_EXTENSION_PATH], daemon.env) },
			];
			const results = await ablate(configs, trialsPerArm);
			const formatted = formatAblation(task.id, results);
			console.log(formatted);
			report.push(formatted);
		}
	} finally {
		await daemon.stop();
	}

	console.log("\n\n=== Full report ===\n");
	console.log(report.join("\n\n"));
}

await main();
