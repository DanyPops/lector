#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { runJob } from "./cli/commands/job.ts";
import { runPackage } from "./cli/commands/package.ts";
import { runSearch } from "./cli/commands/search.ts";
import { lectorServiceCli, lectorServiceSpec, runServe, runService } from "./cli/commands/service.ts";
import { runWorkspace } from "./cli/commands/workspace/index.ts";
import { fail } from "./cli/flags.ts";
import { USAGE } from "./cli/usage.ts";
import { lectorVersion } from "./version.ts";

// Re-exported for import-path stability -- moved to cli/commands/service.ts, the command-group
// module they actually belong to, alongside runServe/runService.
export { lectorServiceCli, lectorServiceSpec };

const ENTRYPOINT_PATH = fileURLToPath(import.meta.url);

const TOP_LEVEL_COMMANDS: Record<string, (rest: string[]) => Promise<void>> = {
	serve: runServe,
	search: runSearch,
	job: runJob,
	package: runPackage,
	workspace: runWorkspace,
};

export async function main(args: readonly string[] = process.argv.slice(2), entrypointPath = ENTRYPOINT_PATH): Promise<void> {
	const [command, ...rest] = args;
	if (command === "--version" || command === "version") {
		console.log(lectorVersion());
		return;
	}
	if (command === "service") {
		runService(rest[0], entrypointPath);
		return;
	}
	const handler = command ? TOP_LEVEL_COMMANDS[command] : undefined;
	if (!handler) fail(USAGE);
	return handler(rest);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
