import { createLogger } from "@danypops/vehicle-server/logging";
import { createServiceCli, type ServiceSpec } from "@danypops/vehicle-server/service";
import { resolveLectorPaths } from "../../constants.ts";
import { serveMain } from "../../daemon.ts";
import type { WorkspaceId } from "../../service.ts";
import { lectorVersion } from "../../version.ts";
import { InMemoryWorkspace } from "../../workspace/in-memory-workspace.ts";
import { LocalFilesystemWorkspace } from "../../workspace/local-filesystem-workspace.ts";
import type { WorkspacePort } from "../../workspace/port.ts";
import { collectFlagValues, fail, hasFlag, nonNegativeIntegerFlag, parseWorkspacePathFlag, positiveIntegerFlag } from "../flags.ts";
import { USAGE } from "../usage.ts";

/** `lector serve` (runs the daemon directly) and `lector service <install|start|stop|restart|status>` (native systemd-unit lifecycle) -- kept together since install's own unit always just re-invokes `serve --dynamic-workspaces`. */

export async function runServe(args: string[]): Promise<void> {
	const memoryIds = collectFlagValues(args, "--workspace");
	const pathEntries = collectFlagValues(args, "--workspace-path").map(parseWorkspacePathFlag);
	const dynamicWorkspaces = hasFlag(args, "--dynamic-workspaces");
	const symbolIndexMemoryBudgetBytes = positiveIntegerFlag(args, "--lsp-memory-budget-bytes", process.env.LECTOR_LSP_MEMORY_BUDGET_BYTES);
	const reservedForegroundSlots = nonNegativeIntegerFlag(args, "--reserved-foreground-slots", process.env.LECTOR_RESERVED_FOREGROUND_SLOTS);
	const backgroundAdmissionQueueTimeoutMs = nonNegativeIntegerFlag(
		args,
		"--background-admission-queue-timeout-ms",
		process.env.LECTOR_BACKGROUND_ADMISSION_QUEUE_TIMEOUT_MS,
	);
	const maxQueuedBackgroundAdmissions = positiveIntegerFlag(args, "--max-queued-background-admissions", process.env.LECTOR_MAX_QUEUED_BACKGROUND_ADMISSIONS);
	const absoluteMaxActiveIndexes = positiveIntegerFlag(args, "--absolute-max-active-indexes", process.env.LECTOR_ABSOLUTE_MAX_ACTIVE_INDEXES);
	if (memoryIds.length === 0 && pathEntries.length === 0 && !dynamicWorkspaces) {
		fail("lector serve requires at least one --workspace <id>, --workspace-path <id>=<dir>, or --dynamic-workspaces");
	}

	const workspaces = new Map<WorkspaceId, WorkspacePort>();
	for (const id of memoryIds) workspaces.set(id, new InMemoryWorkspace());
	for (const { id, dir } of pathEntries) workspaces.set(id, new LocalFilesystemWorkspace(dir));

	const summary =
		[...memoryIds.map((id) => `${id} (in-memory)`), ...pathEntries.map(({ id, dir }) => `${id} (${dir})`)].join(", ") || "none pre-registered, dynamic-only";

	serveMain({
		workspaces,
		allowDynamicOnly: dynamicWorkspaces,
		symbolIndexMemoryBudgetBytes,
		reservedForegroundSlots,
		backgroundAdmissionQueueTimeoutMs,
		maxQueuedBackgroundAdmissions,
		absoluteMaxActiveIndexes,
		logger: createLogger("lector", { levelEnvVar: "LECTOR_LOG_LEVEL" }),
		onListen: ({ host, port }) => {
			console.error(`Lector listening on ${host}:${port} (workspaces: ${summary})`);
		},
	});
}

/**
 * Login/boot persistence lifecycle (`install|start|stop|restart|status`) for a
 * persistent Lector daemon. `install` always runs `serve --dynamic-workspaces`:
 * a long-lived background daemon cannot know upfront which project(s) will
 * attach to it, so it starts with zero pre-registered workspaces and relies
 * entirely on workspace.registerPath at runtime.
 *
 * Native service installation and lifecycle actions go through vehicle-server's
 * shared Armada-backed service CLI. restartOnFailure:true because Lector's own
 * client (client.ts) never auto-spawns, unlike connectWithPolicy's autoStart
 * consumers, so native service supervision is this daemon's only recovery path.
 */
// entrypointPath must be the real bin script's own URL (fileURLToPath(import.meta.url) evaluated
// in cli.ts, the package's actual "bin" target) -- resolving it here instead would generate a
// systemd unit that execs this module directly, which has no top-level `if (import.meta.main)`
// entry guard of its own and would silently do nothing.
export function lectorServiceSpec(entrypointPath: string): ServiceSpec {
	return {
		name: "lector",
		displayName: "Lector filesystem & code-intelligence service",
		version: lectorVersion(),
		binPath: process.execPath,
		args: [entrypointPath, "serve", "--dynamic-workspaces"],
		// The real {host,port,pid} handle file Armada uses for bounded readiness checks --
		// distinct from the old serviceDescriptor path (a systemd-unit-generation location,
		// now obsolete: Armada generates/manages the platform descriptor itself).
		handlePath: resolveLectorPaths().handle,
		restartOnFailure: true,
		restartSec: 2,
	};
}

export function lectorServiceCli(entrypointPath: string) {
	return createServiceCli(lectorServiceSpec(entrypointPath));
}

export function runService(action: string | undefined, entrypointPath: string): void {
	const service = lectorServiceCli(entrypointPath);
	if (action === "install") {
		const result = service.install();
		if (!result.installed) fail(`failed to install the Lector service: ${result.reason}`);
		return;
	}
	if (action === "start" || action === "stop" || action === "restart" || action === "status") {
		service.action(action);
		return;
	}
	fail(USAGE);
}
