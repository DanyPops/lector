#!/usr/bin/env bun
import { InMemoryWorkspace } from "./adapters/in-memory-workspace.ts";
import { connectLectorClient } from "./client.ts";
import { serveMain } from "./daemon.ts";
import type { ContentHash } from "./domain/content-hash.ts";
import type { WorkspacePort } from "./ports/workspace-port.ts";
import type { WorkspaceId } from "./service.ts";

const USAGE = `Usage:
  lector serve --workspace <id> [--workspace <id>...]
  lector workspace read <workspace-id> <path> [--json]
  lector workspace edit <workspace-id> <path> --content <text> (--expected-hash <hash> | --create) [--json]
`;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function collectFlagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === flag) {
			const value = args[index + 1];
			if (value === undefined) fail(`${flag} requires a value`);
			values.push(value);
			index++;
		}
	}
	return values;
}

function flagValue(args: string[], flag: string): string | undefined {
	return collectFlagValues(args, flag).at(-1);
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

async function runServe(args: string[]): Promise<void> {
	const ids = collectFlagValues(args, "--workspace");
	if (ids.length === 0) fail("lector serve requires at least one --workspace <id>");

	// Step 2 of the walking skeleton: in-memory workspaces only. The local-filesystem
	// adapter (walking-skeleton step 3) is a separate, not-yet-landed piece of work.
	const workspaces = new Map<WorkspaceId, WorkspacePort>(ids.map((id) => [id, new InMemoryWorkspace()]));

	serveMain({
		workspaces,
		onListen: ({ host, port }) => {
			console.error(`Lector listening on ${host}:${port} (workspaces: ${ids.join(", ")})`);
		},
	});
}

async function runWorkspaceRead(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.rawRead", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path} [${result.hash}]\n${result.content}`);
}

async function runWorkspaceEdit(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const content = flagValue(flags, "--content");
	if (content === undefined) fail("lector workspace edit requires --content <text>");

	const create = hasFlag(flags, "--create");
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (create === (expectedHashFlag !== undefined)) {
		fail("lector workspace edit requires exactly one of --create or --expected-hash <hash>");
	}
	const expectedHash = create ? null : (expectedHashFlag as ContentHash);

	const client = await connectLectorClient();
	const result = await client.call("workspace.exactEdit", { workspaceId, path, expectedHash, content });
	console.log(
		hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}`,
	);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);

	if (command === "serve") return runServe(rest);

	if (command === "workspace") {
		const [action, workspaceId, path, ...flags] = rest;
		if (action === "read") return runWorkspaceRead(workspaceId, path, flags);
		if (action === "edit") return runWorkspaceEdit(workspaceId, path, flags);
		fail(USAGE);
	}

	fail(USAGE);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
