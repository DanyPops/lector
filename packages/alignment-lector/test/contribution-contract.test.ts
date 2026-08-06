import { describe, expect, it } from "bun:test";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@alignment/surface-protocol";
import { contentHashOf, GuardedLiveBuffer } from "@danypops/lector";
import { createLectorAlignmentContribution, type LectorOperations } from "../src/index.js";

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

describe("Lector Alignment contribution contract", () => {
	it("describes, activates, and disposes the narrow command/resource surface", async () => {
		const operations: LectorOperations = {
			call: async () => {
				throw new Error("unused");
			},
		};
		const contribution = createLectorAlignmentContribution({ operations });
		expect(contribution.describe()).toEqual({
			id: "lector",
			title: "Lector",
			commands: [
				{ id: "lector.workspace.open", title: "Open Workspace" },
				{ id: "lector.file.open", title: "Open File" },
				{ id: "lector.file.save", title: "Save File" },
				{ id: "lector.search.text", title: "Search Text" },
				{ id: "lector.search.files", title: "Find Files" },
				{ id: "lector.symbol.hover", title: "Show Hover" },
				{ id: "lector.symbol.definition", title: "Go to Definition" },
				{ id: "lector.symbol.references", title: "Find References" },
				{ id: "lector.diagnostics.show", title: "Show Diagnostics" },
			],
			resourceSchemes: ["lector"],
		});
		const registered = host();
		await contribution.activate(registered.api);
		expect([...registered.commands.keys()]).toEqual([
			"lector.workspace.open",
			"lector.file.open",
			"lector.file.save",
			"lector.search.text",
			"lector.search.files",
			"lector.symbol.hover",
			"lector.symbol.definition",
			"lector.symbol.references",
			"lector.diagnostics.show",
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
		const contribution = createLectorAlignmentContribution({ operations });
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
		const contribution = createLectorAlignmentContribution({ operations });
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

	it("returns typed invalid-input failures without calling Lector", async () => {
		let called = false;
		const contribution = createLectorAlignmentContribution({
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
