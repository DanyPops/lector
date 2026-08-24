import { basename, isAbsolute, posix } from "node:path";
// Deep imports, not the "@danypops/lector" barrel -- see index.ts's own doc comment on why.
import { remoteErrorIs } from "@danypops/lector/client";
import { GuardedLiveBuffer } from "@danypops/lector/live-buffer/guarded";
import {
	type ContributionHost,
	type ContributionOutcome,
	type ContributionReadBounds,
	ContributionReadBoundsSchema,
	type ContributionResourceReference,
	ContributionResourceReferenceSchema,
	type ZodiacContribution,
} from "@zodiac/protocol";
import { CALL_GRAPH_COMMANDS, createCallGraphContribution } from "./call-graph.js";
import { createGitContribution, GIT_COMMANDS } from "./git-contribution.js";
import { authenticatedLectorOperations, type LectorOperations, withWorkspaceRecovery } from "./lector-operations.js";
import { createSemanticNavigationContribution, SEMANTIC_COMMANDS } from "./semantic-navigation.js";
import { createWorkspaceRootRegistry } from "./workspace-root-registry.js";

const COMMANDS = [
	{ id: "lector.workspace.open", title: "Open Workspace" },
	{ id: "lector.file.open", title: "Open File" },
	{ id: "lector.file.save", title: "Save File" },
	{ id: "lector.file.create", title: "Create File" },
	{ id: "lector.file.delete", title: "Delete File" },
	{ id: "lector.directory.create", title: "Create Directory" },
	{ id: "lector.directory.delete", title: "Delete Directory" },
	{ id: "lector.path.rename", title: "Rename Path" },
] as const;

interface RegisterOutput {
	workspaceId: string;
}
interface RawReadOutput {
	path: string;
	content: string;
	hash: string;
}
interface FileTreeEntryOutput {
	name: string;
	kind: "file" | "directory" | "symlink";
}
interface DirectoryOutput {
	path: string;
	entries: readonly FileTreeEntryOutput[];
}
interface ExactEditOutput {
	path: string;
	newHash: string;
}

function failure(code: string, message: string): ContributionOutcome<never> {
	return { ok: false, code, message };
}
function record(value: unknown): Record<string, unknown> | undefined {
	// This assertion follows the runtime object/null check and never assigns meaning to any field.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function registerOutput(value: unknown): RegisterOutput | undefined {
	const parsed = record(value);
	return parsed && typeof parsed.workspaceId === "string" ? { workspaceId: parsed.workspaceId } : undefined;
}

function rawReadOutput(value: unknown): RawReadOutput | undefined {
	const parsed = record(value);
	return parsed && typeof parsed.path === "string" && typeof parsed.content === "string" && typeof parsed.hash === "string"
		? { path: parsed.path, content: parsed.content, hash: parsed.hash }
		: undefined;
}

function exactEditOutput(value: unknown): ExactEditOutput | undefined {
	const parsed = record(value);
	return parsed && typeof parsed.path === "string" && typeof parsed.newHash === "string" ? { path: parsed.path, newHash: parsed.newHash } : undefined;
}

function directoryOutput(value: unknown): DirectoryOutput | undefined {
	const parsed = record(value);
	if (!parsed || typeof parsed.path !== "string" || !Array.isArray(parsed.entries)) return undefined;
	const entries: FileTreeEntryOutput[] = [];
	for (const candidate of parsed.entries) {
		const entry = record(candidate);
		if (!entry || typeof entry.name !== "string" || (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink")) return undefined;
		entries.push({ name: entry.name, kind: entry.kind });
	}
	return { path: parsed.path, entries };
}

function reference(kind: "workspace" | "text", workspaceId: string, path: string, title: string): ContributionResourceReference {
	return { uri: `lector://${kind}/${encodeURIComponent(workspaceId)}?path=${encodeURIComponent(path)}`, kind, title, readOnly: true };
}

function parseReference(value: ContributionResourceReference): ContributionOutcome<{ workspaceId: string; path: string }> {
	const validated = ContributionResourceReferenceSchema.safeParse(value);
	if (!validated.success || validated.data.readOnly !== true) return failure("invalid-resource", "Lector resources must be valid read-only references");
	try {
		const uri = new URL(validated.data.uri);
		const workspaceId = decodeURIComponent(uri.pathname.slice(1));
		if (uri.protocol !== "lector:" || uri.hostname !== validated.data.kind || workspaceId.length === 0) throw new Error("invalid URI");
		return { ok: true, value: { workspaceId, path: uri.searchParams.get("path") ?? "" } };
	} catch {
		return failure("invalid-resource", "Malformed Lector resource URI");
	}
}

function validWorkspacePath(input: unknown): input is { path: string } {
	const value = record(input);
	return typeof value?.path === "string" && isAbsolute(value.path);
}

function validFileInput(input: unknown): input is { workspaceId: string; path: string } {
	const value = record(input);
	return (
		typeof value?.workspaceId === "string" && value.workspaceId.length > 0 && typeof value.path === "string" && value.path.length > 0 && !isAbsolute(value.path)
	);
}

function validRenameInput(input: unknown): input is { workspaceId: string; oldPath: string; newPath: string; kind?: "workspace" | "text" } {
	const value = record(input);
	if (!value || typeof value.workspaceId !== "string" || value.workspaceId.length === 0) return false;
	if (typeof value.oldPath !== "string" || value.oldPath.length === 0 || isAbsolute(value.oldPath)) return false;
	if (typeof value.newPath !== "string" || value.newPath.length === 0 || isAbsolute(value.newPath)) return false;
	if (value.kind !== undefined && value.kind !== "workspace" && value.kind !== "text") return false;
	return true;
}

function saveResourceInput(input: unknown): ContributionResourceReference | undefined {
	const value = record(input);
	const parsed = ContributionResourceReferenceSchema.safeParse(value?.resource);
	return parsed.success && parsed.data.kind === "text" ? parsed.data : undefined;
}

export function createLectorZodiacContribution(options: { operations?: LectorOperations } = {}): ZodiacContribution {
	const workspaceRoots = createWorkspaceRootRegistry();
	// Every contribution's own operations.call(...) funnels through this one wrapper, so a daemon
	// restart that wipes Lector's in-memory workspace registry (by design, never persisted) is
	// recovered transparently -- re-register the same root (a deterministic hash of the path always
	// yields the identical workspaceId back) and retry the exact failed call once, instead of
	// surfacing UnknownWorkspace to the user until they manually re-run lector.workspace.open.
	const operations = withWorkspaceRecovery(options.operations ?? authenticatedLectorOperations(), workspaceRoots);
	const semanticNavigation = createSemanticNavigationContribution(operations);
	const callGraph = createCallGraphContribution(operations);
	const git = createGitContribution(operations);
	const editors = new Map<string, GuardedLiveBuffer>();
	let unregister: Array<() => void> = [];

	async function openWorkspace(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validWorkspacePath(input)) return failure("invalid-input", "Workspace path must be absolute");
		try {
			const output = registerOutput(await operations.call("workspace.registerPath", { path: input.path }));
			if (!output) return failure("invalid-response", "Lector returned an invalid workspace registration");
			workspaceRoots.remember(output.workspaceId, input.path);
			semanticNavigation.registerWorkspace(output.workspaceId, input.path);
			callGraph.registerWorkspace(output.workspaceId, input.path);
			git.registerWorkspace(output.workspaceId);
			return { ok: true, value: reference("workspace", output.workspaceId, "", basename(input.path) || input.path) };
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector workspace open failed");
		}
	}

	async function openFile(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validFileInput(input)) return failure("invalid-input", "File open requires explicit workspaceId and a relative path");
		try {
			const output = rawReadOutput(await operations.call("workspace.rawRead", { workspaceId: input.workspaceId, path: input.path }));
			if (!output) return failure("invalid-response", "Lector returned an invalid file read");
			const resource = reference("text", input.workspaceId, output.path, basename(output.path));
			if (!editors.has(resource.uri))
				editors.set(resource.uri, new GuardedLiveBuffer({ workspaceId: input.workspaceId, path: output.path }, output.content, output.hash));
			return { ok: true, value: resource };
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector file open failed");
		}
	}

	async function saveFile(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		const resource = saveResourceInput(input);
		if (!resource) return failure("invalid-input", "File save requires a valid text resource");
		const parsed = parseReference(resource);
		if (!parsed.ok) return parsed;
		const editor = editors.get(resource.uri);
		if (!editor) return failure("editor-not-open", "File must be opened as an editor resource before saving");
		if (!editor.dirty) return { ok: true, value: resource };
		const content = editor.buffer.text;
		try {
			const output = exactEditOutput(
				await operations.call("workspace.exactEdit", {
					workspaceId: parsed.value.workspaceId,
					path: parsed.value.path,
					expectedHash: editor.expectedHash,
					content,
				}),
			);
			if (!output || output.path !== parsed.value.path) return failure("invalid-response", "Lector returned an invalid exact-edit outcome");
			editor.markSaved(content, output.newHash);
			return { ok: true, value: resource };
		} catch (error) {
			if (remoteErrorIs(error, "StaleExpectedHash")) {
				try {
					const actual = rawReadOutput(await operations.call("workspace.rawRead", { workspaceId: parsed.value.workspaceId, path: parsed.value.path }));
					editor.markStale(actual?.hash ?? null);
				} catch {
					editor.markStale(null);
				}
				return failure("stale-write", "File changed outside this editor; local edits were preserved");
			}
			return failure("lector-error", error instanceof Error ? error.message : "Lector file save failed");
		}
	}

	/** Same expectedHash:null convention lector.file.save's own workspace.exactEdit call would reject as a create-over-existing -- this is genuinely a create, not a guarded overwrite. */
	async function createFile(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validFileInput(input)) return failure("invalid-input", "File create requires explicit workspaceId and a relative path");
		try {
			const output = exactEditOutput(
				await operations.call("workspace.exactEdit", { workspaceId: input.workspaceId, path: input.path, expectedHash: null, content: "" }),
			);
			if (!output || output.path !== input.path) return failure("invalid-response", "Lector returned an invalid file create outcome");
			const resource = reference("text", input.workspaceId, output.path, basename(output.path));
			editors.set(resource.uri, new GuardedLiveBuffer({ workspaceId: input.workspaceId, path: output.path }, "", output.newHash));
			return { ok: true, value: resource };
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector file create failed");
		}
	}

	async function createDirectory(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validFileInput(input)) return failure("invalid-input", "Directory create requires explicit workspaceId and a relative path");
		try {
			await operations.call("workspace.createDirectory", { workspaceId: input.workspaceId, path: input.path });
			return { ok: true, value: reference("workspace", input.workspaceId, input.path, basename(input.path) || input.path) };
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector directory create failed");
		}
	}

	/**
	 * `kind` is accepted purely to shape the returned resource reference ("workspace" vs "text") --
	 * the daemon's own workspace.renamePath has no notion of file-vs-directory, it just moves
	 * whatever is at oldPath. Defaults to "text" (the common case) when the caller doesn't know or
	 * care, matching how a plain file rename is the overwhelmingly common oil.nvim-style edit.
	 */
	async function renamePath(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validRenameInput(input)) return failure("invalid-input", "Rename requires explicit workspaceId, oldPath, and newPath");
		try {
			await operations.call("workspace.renamePath", { workspaceId: input.workspaceId, oldPath: input.oldPath, newPath: input.newPath });
			const kind = input.kind ?? "text";
			// The old path's own guarded-buffer identity (hash, dirty state) no longer refers to anything
			// real -- drop it rather than let a stale editor linger under a URI that no longer resolves.
			editors.delete(reference(kind, input.workspaceId, input.oldPath, basename(input.oldPath)).uri);
			return { ok: true, value: reference(kind, input.workspaceId, input.newPath, basename(input.newPath) || input.newPath) };
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector rename failed");
		}
	}

	/**
	 * Not a thin pass-through, matching pi-lector's own openDirectoryExplorer: workspace.deleteEntry
	 * is hash-guarded and this contribution only ever has a directory *listing* (no content hash) for
	 * the entry a caller wants deleted, so it reads the file's current hash immediately before
	 * deleting it -- an extra round trip, acceptable for an infrequent interactive action.
	 */
	async function deleteFile(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validFileInput(input)) return failure("invalid-input", "File delete requires explicit workspaceId and a relative path");
		try {
			const current = rawReadOutput(await operations.call("workspace.rawRead", { workspaceId: input.workspaceId, path: input.path }));
			if (!current) return failure("invalid-response", "Lector returned an invalid file read before delete");
			await operations.call("workspace.deleteEntry", { workspaceId: input.workspaceId, path: input.path, expectedHash: current.hash });
			const resource = reference("text", input.workspaceId, input.path, basename(input.path));
			editors.delete(resource.uri);
			return { ok: true, value: resource };
		} catch (error) {
			if (remoteErrorIs(error, "StaleExpectedHash")) return failure("stale-write", "File changed outside this editor; delete was not applied");
			return failure("lector-error", error instanceof Error ? error.message : "Lector file delete failed");
		}
	}

	async function deleteDirectory(input: unknown): Promise<ContributionOutcome<ContributionResourceReference>> {
		if (!validFileInput(input)) return failure("invalid-input", "Directory delete requires explicit workspaceId and a relative path");
		try {
			await operations.call("workspace.deleteDirectory", { workspaceId: input.workspaceId, path: input.path });
			return { ok: true, value: reference("workspace", input.workspaceId, input.path, basename(input.path) || input.path) };
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector directory delete failed");
		}
	}

	async function readResource(resource: ContributionResourceReference, bounds: ContributionReadBounds): Promise<ContributionOutcome<unknown>> {
		const bounded = ContributionReadBoundsSchema.safeParse(bounds);
		if (!bounded.success) return failure("invalid-bounds", "Resource read bounds are invalid");
		const semantic = semanticNavigation.read(resource, bounded.data);
		if (semantic) return semantic;
		const graph = callGraph.read(resource, bounded.data);
		if (graph) return graph;
		const gitResource = git.read(resource, bounded.data);
		if (gitResource) return gitResource;
		const parsed = parseReference(resource);
		if (!parsed.ok) return parsed;
		try {
			if (resource.kind === "workspace") {
				const output = directoryOutput(await operations.call("workspace.listDirectory", { workspaceId: parsed.value.workspaceId, path: parsed.value.path }));
				if (!output) return failure("invalid-response", "Lector returned an invalid directory listing");
				if (output.entries.length > bounded.data.maxEntries)
					return failure("resource-bound-exceeded", `Directory has ${output.entries.length} entries; cap is ${bounded.data.maxEntries}`);
				const entries = output.entries.map((entry) => {
					const path = output.path === "" || output.path === "." ? entry.name : posix.join(output.path, entry.name);
					const kind = entry.kind === "directory" ? "workspace" : "text";
					return { ...entry, resource: reference(kind, parsed.value.workspaceId, path, entry.name) };
				});
				return { ok: true, value: { kind: "tree", workspaceId: parsed.value.workspaceId, path: output.path, entries, readOnly: true } };
			}
			if (resource.kind === "text") {
				let editor = editors.get(resource.uri);
				if (!editor) {
					const output = rawReadOutput(await operations.call("workspace.rawRead", { workspaceId: parsed.value.workspaceId, path: parsed.value.path }));
					if (!output) return failure("invalid-response", "Lector returned an invalid file read");
					editor = new GuardedLiveBuffer({ workspaceId: parsed.value.workspaceId, path: output.path }, output.content, output.hash);
					editors.set(resource.uri, editor);
				}
				const content = editor.buffer.text;
				const bytes = Buffer.byteLength(content, "utf8");
				if (bytes > bounded.data.maxBytes) return failure("resource-bound-exceeded", `File is ${bytes} bytes; cap is ${bounded.data.maxBytes}`);
				return {
					ok: true,
					value: {
						kind: "text",
						workspaceId: parsed.value.workspaceId,
						path: parsed.value.path,
						content,
						hash: editor.expectedHash,
						bytes,
						dirty: editor.dirty,
						editor,
						readOnly: true,
					},
				};
			}
			return failure("unsupported-resource", `Unsupported Lector resource kind: ${resource.kind}`);
		} catch (error) {
			return failure("lector-error", error instanceof Error ? error.message : "Lector resource read failed");
		}
	}

	return {
		describe: () => ({
			id: "lector",
			title: "Lector",
			commands: [...COMMANDS, ...SEMANTIC_COMMANDS, ...CALL_GRAPH_COMMANDS, ...GIT_COMMANDS],
			resourceSchemes: ["lector"],
			// Opts into Zodiac's own agent-invokable integration.invoke dispatch
			// path -- every command above becomes callable by an authorized
			// agent session through the identical per-call
			// authorizeAgentCommand/tool-grant gate a human dispatch goes
			// through, not a bypass of it.
			capabilities: ["agent-invokable"],
		}),
		activate(host: ContributionHost) {
			if (unregister.length > 0) throw new Error("Lector contribution is already active");
			unregister = [
				host.registerCommand({ ...COMMANDS[0], execute: openWorkspace }),
				host.registerCommand({ ...COMMANDS[1], execute: openFile }),
				host.registerCommand({ ...COMMANDS[2], execute: saveFile }),
				host.registerCommand({ ...COMMANDS[3], execute: createFile }),
				host.registerCommand({ ...COMMANDS[4], execute: deleteFile }),
				host.registerCommand({ ...COMMANDS[5], execute: createDirectory }),
				host.registerCommand({ ...COMMANDS[6], execute: deleteDirectory }),
				host.registerCommand({ ...COMMANDS[7], execute: renamePath }),
				...semanticNavigation.commands.map((command) => host.registerCommand(command)),
				...callGraph.commands.map((command) => host.registerCommand(command)),
				...git.commands.map((command) => host.registerCommand(command)),
				host.registerResourceProvider({ scheme: "lector", read: readResource }),
			];
		},
		dispose() {
			for (const remove of unregister.splice(0).reverse()) remove();
			editors.clear();
			semanticNavigation.clear();
			callGraph.clear();
			git.clear();
			workspaceRoots.forgetAll();
		},
	};
}
