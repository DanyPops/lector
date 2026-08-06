import { describe, expect, it } from "bun:test";
import type { ContributionCommand, ContributionResourceProvider } from "@alignment/surface-protocol";
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
			],
			resourceSchemes: ["lector"],
		});
		const registered = host();
		await contribution.activate(registered.api);
		expect([...registered.commands.keys()]).toEqual(["lector.workspace.open", "lector.file.open"]);
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
				if (operation === "workspace.rawRead") return { path: "src/a.ts", content: "export const a = 1;", hash: "a".repeat(64) };
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
