import { resolve } from "node:path";
import { connectLectorClient, resolveLectorDaemonConnection } from "../../../client.ts";
import type { ContentHash } from "../../../content-identity/content-hash.ts";
import { collectFlagValues, fail, flagValue, hasFlag, requiredIntFlag } from "../../flags.ts";
import { USAGE } from "../../usage.ts";
import type { ActionHandler } from "../action-handler.ts";

/** Raw filesystem primitives -- register/read/edit/delete/list-directory/create-directory/rename-path/delete-directory/line-edit/apply-patch/watch/unwatch/search-text/find-files. Mirrors service/workspace-file-handlers.ts's own scope. */

export async function runWorkspaceRegister(dir: string | undefined, flags: string[]): Promise<void> {
	if (!dir) fail(USAGE);
	// Resolved here, against THIS process's own cwd -- the daemon is a long-running shared
	// service with no meaningful "current directory" relative to any particular caller, so it
	// rejects a relative path outright rather than guessing. The CLI is the one process that
	// actually knows what the invoking shell meant by "." or a bare relative directory name.
	const client = await connectLectorClient();
	const result = await client.call("workspace.registerPath", { path: resolve(dir) });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.workspaceId} (${result.created ? "created" : "already registered"})`);
}

export async function runWorkspaceRead(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.rawRead", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path} [${result.hash}]\n${result.content}`);
}

export async function runWorkspaceEdit(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const content = flagValue(flags, "--content");
	if (content === undefined) fail("lector workspace edit requires --content <text>");

	const create = hasFlag(flags, "--create");
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (create === (expectedHashFlag !== undefined)) {
		fail("lector workspace edit requires exactly one of --create or --expected-hash <hash>");
	}
	// A raw CLI flag; the daemon rejects an invalid hash with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const expectedHash = create ? null : (expectedHashFlag as ContentHash);

	const client = await connectLectorClient();
	const result = await client.call("workspace.exactEdit", { workspaceId, path, expectedHash, content });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash ?? "(new)"} -> ${result.newHash}`);
}

export async function runWorkspaceLineEdit(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const editsJson = flagValue(flags, "--edits");
	if (editsJson === undefined) fail("lector workspace line-edit requires --edits <json>");
	let edits: unknown;
	try {
		edits = JSON.parse(editsJson);
	} catch (error) {
		fail(`--edits is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(edits)) fail("--edits must be a JSON array of LineEdit objects");

	const client = await connectLectorClient();
	const result = await client.call("workspace.lineEdit", { workspaceId, path, edits });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash} -> ${result.newHash}`);
}

export async function runWorkspaceDelete(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (expectedHashFlag === undefined) fail("lector workspace delete requires --expected-hash <hash>");
	// A raw CLI flag; the daemon rejects an invalid hash with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const expectedHash = expectedHashFlag as ContentHash;

	const client = await connectLectorClient();
	const result = await client.call("workspace.deleteEntry", { workspaceId, path, expectedHash });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `deleted "${result.path}" (was ${result.previousHash ?? "(absent)"})`);
}

export async function runWorkspaceListDirectory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.listDirectory", { workspaceId, path: path ?? "" });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	for (const entry of result.entries) console.log(entry.kind === "directory" ? `${entry.name}/` : entry.name);
}

export async function runWorkspaceCreateDirectory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.createDirectory", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `created directory "${result.path}"`);
}

export async function runWorkspaceRenamePath(
	workspaceId: string | undefined,
	oldPath: string | undefined,
	newPath: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !oldPath || !newPath) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.renamePath", { workspaceId, oldPath, newPath });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `"${result.oldPath}" -> "${result.newPath}"`);
}

export async function runWorkspaceDeleteDirectory(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.deleteDirectory", { workspaceId, path });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `deleted directory "${result.path}"`);
}

export async function runWorkspaceWatch(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const pattern = flagValue(flags, "--pattern");
	if (!pattern) fail("lector workspace watch requires --pattern <glob>");
	const json = hasFlag(flags, "--json");

	const client = await connectLectorClient();
	const { watchId, topic } = await client.call("workspace.watch", { workspaceId, pattern });
	const { host, port, token } = resolveLectorDaemonConnection();
	if (!json) console.error(`watching "${pattern}" in workspace ${workspaceId} (watchId ${watchId}) -- Ctrl-C to stop`);

	const ws = new WebSocket(`ws://${host}:${port}/push?token=${token}`);
	await new Promise<void>((resolvePromise, reject) => {
		ws.addEventListener("open", () => resolvePromise());
		ws.addEventListener("error", () => reject(new Error("failed to connect to the daemon's push channel")));
	});
	ws.addEventListener("message", (event) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(event.data));
		} catch {
			return;
		}
		// Naming the two expected top-level keys while leaving their values as-is; every access
		// below already treats them as possibly absent.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const message = parsed as { topic?: string; payload?: { path?: string; kind?: string } };
		if (message.topic !== topic) return;
		if (json) {
			console.log(JSON.stringify(message.payload));
			return;
		}
		console.log(`${message.payload?.kind}\t${message.payload?.path}`);
	});
	ws.send(JSON.stringify({ op: "subscribe", topic }));

	// Blocks until Ctrl-C -- the real, intended shape of this command (`tail -f`, not a
	// request/response call), then cleans up its own registration rather than leaking a watch
	// (and the OS watcher it may be the last reference to) every time a caller stops watching.
	await new Promise<void>((resolvePromise) => {
		process.once("SIGINT", () => resolvePromise());
	});
	ws.close();
	await client.call("workspace.unwatch", { watchId }).catch(() => {});
}

export async function runWorkspaceUnwatch(watchId: string | undefined, flags: string[]): Promise<void> {
	if (!watchId) fail(USAGE);
	const client = await connectLectorClient();
	const result = await client.call("workspace.unwatch", { watchId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : result.unwatched ? "unwatched" : "no such watch (already removed or never existed)");
}

export async function runWorkspaceApplyPatch(workspaceId: string | undefined, path: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !path) fail(USAGE);
	const patchText = flagValue(flags, "--patch");
	if (patchText === undefined) fail("lector workspace apply-patch requires --patch <unified-diff-text>");
	const expectedHashFlag = flagValue(flags, "--expected-hash");
	if (expectedHashFlag === undefined) fail("lector workspace apply-patch requires --expected-hash <hash>");
	// A raw CLI flag; the daemon rejects an invalid hash with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const expectedHash = expectedHashFlag as ContentHash;

	const client = await connectLectorClient();
	const result = await client.call("workspace.applyPatch", { workspaceId, path, expectedHash, patchText });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(result) : `${result.path}: ${result.previousHash} -> ${result.newHash}`);
}

export async function runWorkspaceSearchText(workspaceId: string | undefined, query: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !query) fail(USAGE);
	const maxMatches = requiredIntFlag(flags, "--max-matches");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.searchText", { workspaceId, query, maxMatches, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.matches.length === 0) {
		console.log(`no matches for "${query}"`);
		return;
	}
	for (const match of result.matches) console.log(`${match.path}:${match.lineNumber}: ${match.line.replace(/\n$/, "")}`);
	if (result.truncated) console.log("... (truncated)");
}

export async function runWorkspaceFindFiles(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const patterns = collectFlagValues(flags, "--pattern");
	if (patterns.length === 0) fail("workspace find-files requires at least one --pattern");
	const maxResults = requiredIntFlag(flags, "--max-results");
	const maxBytes = requiredIntFlag(flags, "--max-bytes");
	const client = await connectLectorClient();
	const result = await client.call("workspace.findFiles", { workspaceId, patterns, maxResults, maxBytes });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.paths.length === 0) {
		console.log(`no files match ${patterns.map((pattern) => `"${pattern}"`).join(", ")}`);
		return;
	}
	for (const path of result.paths) console.log(path);
	if (result.truncated) console.log("... (truncated)");
}

export const FILE_OPS_ACTIONS: Record<string, ActionHandler> = {
	register: (actionArgs) => {
		const [dir, ...flags] = actionArgs;
		return runWorkspaceRegister(dir, flags);
	},
	read: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceRead(workspaceId, path, flags);
	},
	edit: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceEdit(workspaceId, path, flags);
	},
	delete: (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDelete(workspaceId, path, flags);
	},
	"list-directory": (actionArgs) => {
		// <path> is optional here (defaults to the workspace root) -- a generic
		// [workspaceId, path, ...flags] destructure would misparse a bare `--json` with no path
		// positional as path itself, the same flag-vs-positional bug git-status/compare-symbol below guard against.
		const [ldWorkspaceId, ...ldRest] = actionArgs;
		const ldPath = ldRest[0]?.startsWith("--") ? undefined : ldRest[0];
		const ldFlags = ldPath === undefined ? ldRest : ldRest.slice(1);
		return runWorkspaceListDirectory(ldWorkspaceId, ldPath, ldFlags);
	},
	"create-directory": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceCreateDirectory(workspaceId, path, flags);
	},
	"delete-directory": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceDeleteDirectory(workspaceId, path, flags);
	},
	"rename-path": (actionArgs) => {
		// `path` here is really <old-path>; the generic [workspaceId, path, ...flags] destructure
		// still lines up correctly since rename-path's own second positional IS old-path.
		const [workspaceId, path, ...flags] = actionArgs;
		const [rpNewPath, ...rpFlags] = flags;
		return runWorkspaceRenamePath(workspaceId, path, rpNewPath, rpFlags);
	},
	"line-edit": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceLineEdit(workspaceId, path, flags);
	},
	"apply-patch": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceApplyPatch(workspaceId, path, flags);
	},
	watch: (actionArgs) => {
		const [workspaceId] = actionArgs;
		return runWorkspaceWatch(workspaceId, actionArgs.slice(1));
	},
	unwatch: (actionArgs) => {
		const [workspaceId, , ...flags] = actionArgs;
		return runWorkspaceUnwatch(workspaceId, flags);
	},
	"search-text": (actionArgs) => {
		const [workspaceId, path, ...flags] = actionArgs;
		return runWorkspaceSearchText(workspaceId, path, flags);
	},
	"find-files": (actionArgs) => {
		const [workspaceId] = actionArgs;
		return runWorkspaceFindFiles(workspaceId, actionArgs.slice(1));
	},
};
