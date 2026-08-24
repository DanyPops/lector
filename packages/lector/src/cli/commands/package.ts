import { resolve } from "node:path";
import { connectLectorClient } from "../../client.ts";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS } from "../../package-source/package-source.ts";
import { fail, flagValue, hasFlag, parseEcosystemFlag, requiredIntFlag, requireEcosystem } from "../flags.ts";
import { formatPackageSourceListEntry, formatPackageSourceResult } from "../format.ts";
import { USAGE } from "../usage.ts";
import type { ActionHandler } from "./action-handler.ts";

/** package.resolveSource/listSources/removeSource/cleanSources -- the verified-source bookkeeping command group. */

export async function runPackageSource(projectDir: string | undefined, packageName: string | undefined, flags: string[]): Promise<void> {
	if (!projectDir || !packageName) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("package.resolveSource", {
		request: {
			projectRoot: resolve(projectDir),
			coordinate: {
				ecosystem: parseEcosystemFlag(flags) ?? "npm",
				registry: flagValue(flags, "--registry") ?? null,
				name: packageName,
				requestedVersion: flagValue(flags, "--version") ?? null,
			},
		},
		bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS,
	});
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : formatPackageSourceResult(result));
}

export async function runPackageListSources(flags: string[]): Promise<void> {
	const maxResults = requiredIntFlag(flags, "--max-results");
	const ecosystem = parseEcosystemFlag(flags);
	const text = flagValue(flags, "--query");
	const cursor = flagValue(flags, "--cursor");
	const client = await connectLectorClient();
	const page = await client.call("package.listSources", { maxResults, ecosystem, text, cursor });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(page));
		return;
	}
	if (page.entries.length === 0) {
		console.log("no resolved package sources");
		return;
	}
	for (const entry of page.entries) console.log(formatPackageSourceListEntry(entry));
	if (page.nextCursor) console.log(`--cursor ${page.nextCursor} for more`);
}

export async function runPackageRemoveSource(
	ecosystem: string | undefined,
	name: string | undefined,
	resolvedVersion: string | undefined,
	flags: string[],
): Promise<void> {
	if (!name || !resolvedVersion) fail(USAGE);
	const validEcosystem = requireEcosystem(ecosystem);
	const registry = flagValue(flags, "--registry") ?? null;
	const client = await connectLectorClient();
	const result = await client.call("package.removeSource", { ecosystem: validEcosystem, registry, name, resolvedVersion });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	console.log(result.removed ? "removed" : "not recorded for that coordinate");
}

export async function runPackageCleanSources(flags: string[]): Promise<void> {
	const ecosystem = parseEcosystemFlag(flags);
	const client = await connectLectorClient();
	const result = await client.call("package.cleanSources", { ecosystem });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `removed ${result.removed}, skipped ${result.skipped} (still in use)`);
}

const PACKAGE_ACTIONS: Record<string, ActionHandler> = {
	source: (actionRest) => {
		const [projectDir, packageName, ...packageFlags] = actionRest;
		return runPackageSource(projectDir, packageName, packageFlags);
	},
	"list-sources": (actionRest) => runPackageListSources(actionRest),
	"remove-source": (actionRest) => {
		const [ecosystem, name, resolvedVersion, ...removeFlags] = actionRest;
		return runPackageRemoveSource(ecosystem, name, resolvedVersion, removeFlags);
	},
	"clean-sources": (actionRest) => runPackageCleanSources(actionRest),
};

export async function runPackage(rest: string[]): Promise<void> {
	const [action, ...actionRest] = rest;
	const handler = action ? PACKAGE_ACTIONS[action] : undefined;
	if (!handler) fail(USAGE);
	return handler(actionRest);
}
