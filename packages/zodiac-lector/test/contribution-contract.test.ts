import { describe, expect, it } from "bun:test";
import { contentHashOf, GuardedLiveBuffer } from "@danypops/lector";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@zodiac/protocol";
import { createLectorZodiacContribution, type LectorOperations } from "../src/index.js";

function host() {
	const commands = new Map<string, ContributionCommand>();
	const providers = new Map<string, ContributionResourceProvider>();
	return {
		commands,
		providers,
		api: {
			registerCommand(command: ContributionCommand) {
				commands.set(command.id, command);
				return () => commands.delete(command.id);
			},
			registerResourceProvider(provider: ContributionResourceProvider) {
				providers.set(provider.scheme, provider);
				return () => providers.delete(provider.scheme);
			},
		},
	};
}

function requireCommand(commands: ReadonlyMap<string, ContributionCommand>, id: string): ContributionCommand {
	const command = commands.get(id);
	if (!command) throw new Error(`Missing command: ${id}`);
	return command;
}

function resourceValue(outcome: Awaited<ReturnType<ContributionCommand["execute"]>>): ContributionResourceReference {
	if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
	return outcome.value;
}

describe("Lector Zodiac contribution contract", () => {
	it("describes, activates, and disposes the narrow command/resource surface", async () => {
		const operations: LectorOperations = {
			call: async () => {
				throw new Error("unused");
			},
		};
		const contribution = createLectorZodiacContribution({ operations });
		expect(contribution.describe()).toEqual({
			id: "lector",
			title: "Lector",
			commands: [
				{ id: "lector.workspace.open", title: "Open Workspace" },
				{ id: "lector.file.open", title: "Open File" },
				{ id: "lector.file.save", title: "Save File" },
				{ id: "lector.file.create", title: "Create File" },
				{ id: "lector.file.delete", title: "Delete File" },
				{ id: "lector.directory.create", title: "Create Directory" },
				{ id: "lector.directory.delete", title: "Delete Directory" },
				{ id: "lector.path.rename", title: "Rename Path" },
				{ id: "lector.search.text", title: "Search Text" },
				{ id: "lector.search.files", title: "Find Files" },
				{ id: "lector.symbol.hover", title: "Show Hover" },
				{ id: "lector.symbol.definition", title: "Go to Definition" },
				{ id: "lector.symbol.references", title: "Find References" },
				{ id: "lector.diagnostics.show", title: "Show Diagnostics" },
				{ id: "lector.call-graph.prepare", title: "Prepare Call Hierarchy" },
				{ id: "lector.call-graph.incoming", title: "Show Callers" },
				{ id: "lector.call-graph.outgoing", title: "Show Callees" },
				{ id: "lector.call-graph.reachable", title: "Show Reachable Calls" },
				{ id: "lector.git.status", title: "Show Git Status" },
				{ id: "lector.git.log", title: "Show Git Log" },
				{ id: "lector.git.diff", title: "Show Git Diff" },
				{ id: "lector.git.compare-symbol", title: "Compare Symbol Across Revisions" },
			],
			resourceSchemes: ["lector"],
		});
		const registered = host();
		await contribution.activate(registered.api);
		expect([...registered.commands.keys()]).toEqual([
			"lector.workspace.open",
			"lector.file.open",
			"lector.file.save",
			"lector.file.create",
			"lector.file.delete",
			"lector.directory.create",
			"lector.directory.delete",
			"lector.path.rename",
			"lector.search.text",
			"lector.search.files",
			"lector.symbol.hover",
			"lector.symbol.definition",
			"lector.symbol.references",
			"lector.diagnostics.show",
			"lector.call-graph.prepare",
			"lector.call-graph.incoming",
			"lector.call-graph.outgoing",
			"lector.call-graph.reachable",
			"lector.git.status",
			"lector.git.log",
			"lector.git.diff",
			"lector.git.compare-symbol",
		]);
		expect([...registered.providers.keys()]).toEqual(["lector"]);
		await contribution.dispose();
		expect(registered.commands.size).toBe(0);
		expect(registered.providers.size).toBe(0);
	});

	it("opens workspace and file references with explicit identity and read-only authority", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				calls.push({ operation, input });
				if (operation === "workspace.registerPath") return { workspaceId: "ws-1", created: true };
				if (operation === "workspace.rawRead") return { path: "src/a.ts", content: "export const a = 1;", hash: contentHashOf("export const a = 1;") };
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.workspace.open").execute({ path: "/tmp/project" })).toMatchObject({
			ok: true,
			value: { kind: "workspace", readOnly: true },
		});
		expect(await requireCommand(registered.commands, "lector.file.open").execute({ workspaceId: "ws-1", path: "src/a.ts" })).toMatchObject({
			ok: true,
			value: { kind: "text", readOnly: true },
		});
		expect(calls).toEqual([
			{ operation: "workspace.registerPath", input: { path: "/tmp/project" } },
			{ operation: "workspace.rawRead", input: { workspaceId: "ws-1", path: "src/a.ts" } },
		]);
	});

	it("projects a Lector-owned dirty buffer and refreshes its guard after each save", async () => {
		const exactEdits: unknown[] = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				if (operation === "workspace.rawRead") return { path: "a.txt", content: "one", hash: contentHashOf("one") };
				if (operation === "workspace.exactEdit") {
					exactEdits.push(input);
					if (typeof input !== "object" || input === null || !("content" in input) || typeof input.content !== "string") throw new Error("invalid edit input");
					return { path: "a.txt", previousHash: "unused", newHash: contentHashOf(input.content) };
				}
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		const file = resourceValue(await requireCommand(registered.commands, "lector.file.open").execute({ workspaceId: "ws", path: "a.txt" }));
		const provider = registered.providers.get("lector");
		if (!provider) throw new Error("Missing provider");
		const projected = await provider.read(file, { maxBytes: 100, maxEntries: 10 });
		if (!projected.ok || typeof projected.value !== "object" || projected.value === null || !("editor" in projected.value)) throw new Error("Missing editor");
		const editor = projected.value.editor;
		if (!(editor instanceof GuardedLiveBuffer)) throw new Error("Invalid editor");
		editor.buffer.replace(0, editor.buffer.length, "two");
		expect(editor.dirty).toBe(true);
		expect(await requireCommand(registered.commands, "lector.file.save").execute({ resource: file })).toEqual({ ok: true, value: file });
		expect(editor.dirty).toBe(false);
		editor.buffer.replace(0, editor.buffer.length, "three");
		expect(await requireCommand(registered.commands, "lector.file.save").execute({ resource: file })).toEqual({ ok: true, value: file });
		expect(await requireCommand(registered.commands, "lector.file.save").execute({ resource: file })).toEqual({ ok: true, value: file });
		expect(exactEdits).toEqual([
			{ workspaceId: "ws", path: "a.txt", expectedHash: contentHashOf("one"), content: "two" },
			{ workspaceId: "ws", path: "a.txt", expectedHash: contentHashOf("two"), content: "three" },
		]);
	});

	it("creates a file through an unguarded expectedHash:null exactEdit, then tracks it as an editable buffer", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				calls.push({ operation, input });
				if (operation === "workspace.exactEdit") return { path: "new.ts", previousHash: null, newHash: contentHashOf("") };
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		const created = await requireCommand(registered.commands, "lector.file.create").execute({ workspaceId: "ws", path: "new.ts" });
		expect(created).toMatchObject({ ok: true, value: { kind: "text", readOnly: true } });
		expect(calls).toEqual([{ operation: "workspace.exactEdit", input: { workspaceId: "ws", path: "new.ts", expectedHash: null, content: "" } }]);
		// The newly-created file is immediately editable/savable without a separate lector.file.open round trip.
		const resource = resourceValue(created);
		const provider = registered.providers.get("lector");
		if (!provider) throw new Error("Missing provider");
		const projected = await provider.read(resource, { maxBytes: 100, maxEntries: 10 });
		expect(projected).toMatchObject({ ok: true, value: { kind: "text", content: "", dirty: false } });
	});

	it("creates a directory", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				calls.push({ operation, input });
				if (operation === "workspace.createDirectory") return {};
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.directory.create").execute({ workspaceId: "ws", path: "newdir" })).toMatchObject({
			ok: true,
			value: { kind: "workspace", readOnly: true },
		});
		expect(calls).toEqual([{ operation: "workspace.createDirectory", input: { workspaceId: "ws", path: "newdir" } }]);
	});

	it("renames a path and evicts any editor open under the old path's own resource identity", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				calls.push({ operation, input });
				if (operation === "workspace.rawRead") return { path: "old.ts", content: "x", hash: contentHashOf("x") };
				if (operation === "workspace.renamePath") return { oldPath: "old.ts", newPath: "renamed.ts" };
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		// Open the file first so there's a real editor entry under its old-path resource to evict.
		const opened = resourceValue(await requireCommand(registered.commands, "lector.file.open").execute({ workspaceId: "ws", path: "old.ts" }));
		const renamed = await requireCommand(registered.commands, "lector.path.rename").execute({ workspaceId: "ws", oldPath: "old.ts", newPath: "renamed.ts" });
		expect(renamed).toMatchObject({ ok: true, value: { kind: "text", readOnly: true } });
		expect(calls).toEqual([
			{ operation: "workspace.rawRead", input: { workspaceId: "ws", path: "old.ts" } },
			{ operation: "workspace.renamePath", input: { workspaceId: "ws", oldPath: "old.ts", newPath: "renamed.ts" } },
		]);
		// The old resource's editor is gone -- reading it again would require a fresh workspace.rawRead.
		const provider = registered.providers.get("lector");
		if (!provider) throw new Error("Missing provider");
		const rereadOld = await provider.read(opened, { maxBytes: 100, maxEntries: 10 });
		expect(calls.length).toBeGreaterThan(2); // reading the stale resource triggered a fresh rawRead, proving the old editor entry was evicted
		expect(rereadOld.ok).toBe(true);
	});

	it("deletes a file after reading its current hash first (not a thin pass-through)", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				calls.push({ operation, input });
				if (operation === "workspace.rawRead") return { path: "gone.ts", content: "x", hash: contentHashOf("x") };
				if (operation === "workspace.deleteEntry") return { path: "gone.ts", previousHash: contentHashOf("x") };
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.file.delete").execute({ workspaceId: "ws", path: "gone.ts" })).toMatchObject({
			ok: true,
			value: { kind: "text", readOnly: true },
		});
		expect(calls).toEqual([
			{ operation: "workspace.rawRead", input: { workspaceId: "ws", path: "gone.ts" } },
			{ operation: "workspace.deleteEntry", input: { workspaceId: "ws", path: "gone.ts", expectedHash: contentHashOf("x") } },
		]);
	});

	it("surfaces a stale hash on delete as a typed failure instead of deleting the wrong content", async () => {
		const operations: LectorOperations = {
			call: async (operation) => {
				if (operation === "workspace.rawRead") return { path: "gone.ts", content: "x", hash: contentHashOf("x") };
				if (operation === "workspace.deleteEntry") throw new Error("StaleExpectedHash: file changed on disk");
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.file.delete").execute({ workspaceId: "ws", path: "gone.ts" })).toMatchObject({
			ok: false,
			code: "stale-write",
		});
	});

	it("deletes a directory", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const operations: LectorOperations = {
			call: async (operation, input) => {
				calls.push({ operation, input });
				if (operation === "workspace.deleteDirectory") return {};
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		const contribution = createLectorZodiacContribution({ operations });
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.directory.delete").execute({ workspaceId: "ws", path: "olddir" })).toMatchObject({
			ok: true,
			value: { kind: "workspace", readOnly: true },
		});
		expect(calls).toEqual([{ operation: "workspace.deleteDirectory", input: { workspaceId: "ws", path: "olddir" } }]);
	});

	it("returns typed invalid-input failures for every new mutation command without calling Lector", async () => {
		let called = false;
		const contribution = createLectorZodiacContribution({
			operations: {
				call: async () => {
					called = true;
					throw new Error("unexpected");
				},
			},
		});
		const registered = host();
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.file.create").execute({ workspaceId: "ws", path: "/abs.ts" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(await requireCommand(registered.commands, "lector.file.delete").execute({ path: "a.ts" })).toMatchObject({ ok: false, code: "invalid-input" });
		expect(await requireCommand(registered.commands, "lector.directory.create").execute({ workspaceId: "ws", path: "/abs" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(await requireCommand(registered.commands, "lector.directory.delete").execute({ workspaceId: "", path: "a" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(await requireCommand(registered.commands, "lector.path.rename").execute({ workspaceId: "ws", oldPath: "a" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(called).toBe(false);
	});

	it("returns typed invalid-input failures without calling Lector", async () => {
		let called = false;
		const contribution = createLectorZodiacContribution({
			operations: {
				call: async () => {
					called = true;
					throw new Error("unexpected");
				},
			},
		});
		const registered = host();
		await contribution.activate(registered.api);
		expect(await requireCommand(registered.commands, "lector.workspace.open").execute({ path: "." })).toMatchObject({ ok: false, code: "invalid-input" });
		expect(await requireCommand(registered.commands, "lector.file.open").execute({ path: "a.ts" })).toMatchObject({ ok: false, code: "invalid-input" });
		expect(called).toBe(false);
	});
});
