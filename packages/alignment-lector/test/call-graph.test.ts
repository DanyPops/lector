import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@alignment/surface-protocol";
import { createLectorAlignmentContribution, type LectorOperations, lectorOperationsFromClient } from "../src/index.js";
import { startIsolatedDaemon } from "./support/isolated-daemon.js";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/call-graph");
const CALL_GRAPH_PATH = "src/math.ts";

function host() {
	const commands = new Map<string, ContributionCommand>();
	let provider: ContributionResourceProvider | undefined;
	return {
		commands,
		provider: () => provider,
		api: {
			registerCommand(command: ContributionCommand) {
				commands.set(command.id, command);
				return () => commands.delete(command.id);
			},
			registerResourceProvider(value: ContributionResourceProvider) {
				provider = value;
				return () => {
					provider = undefined;
				};
			},
		},
	};
}

function command(commands: ReadonlyMap<string, ContributionCommand>, id: string): ContributionCommand {
	const found = commands.get(id);
	if (!found) throw new Error(`Missing command: ${id}`);
	return found;
}

function reference(outcome: Awaited<ReturnType<ContributionCommand["execute"]>>): ContributionResourceReference {
	if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
	return outcome.value;
}

async function read(provider: ContributionResourceProvider | undefined, resource: ContributionResourceReference, maxEntries = 100): Promise<unknown> {
	if (!provider) throw new Error("Missing provider");
	const outcome = await provider.read(resource, { maxBytes: 100_000, maxEntries });
	if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
	return outcome.value;
}

function provenance(freshness: "live-process" | "content-hash" = "live-process") {
	return {
		fidelity: "semantic",
		backend: "typescript-language-server",
		languageId: "typescript",
		authority: "language-server",
		freshness,
		limitations: [],
	};
}

function hierarchy(name: string, path: string, line: number, character: number) {
	return {
		name,
		kind: "function",
		location: { path, line, character },
		range: { path, start: { line, character }, end: { line, character: character + name.length } },
	};
}

describe("Lector Alignment call graph", () => {
	let stop: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await stop?.();
		stop = undefined;
	});

	it("projects live callers/callees and persisted reachable nodes from a real TypeScript language server", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		const registered = host();
		await createLectorAlignmentContribution({ operations: lectorOperationsFromClient(daemon.client) }).activate(registered.api);
		const workspace = reference(await command(registered.commands, "lector.workspace.open").execute({ path: FIXTURE_ROOT }));
		const workspaceId = decodeURIComponent(new URL(workspace.uri).pathname.slice(1));

		const prepared = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.prepare").execute({
					workspaceId,
					path: CALL_GRAPH_PATH,
					line: 5,
					character: 17,
					maxNodes: 20,
					maxEdges: 20,
					maxBytes: 50_000,
					deadlineMs: 10_000,
				}),
			),
		);
		expect(prepared).toMatchObject({ direction: "prepare", nodes: [expect.objectContaining({ name: "middle" })], edges: [] });

		const incoming = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.incoming").execute({
					workspaceId,
					path: CALL_GRAPH_PATH,
					line: 1,
					character: 17,
					maxNodes: 20,
					maxEdges: 20,
					maxBytes: 50_000,
					deadlineMs: 10_000,
				}),
			),
		);
		const incomingNodes = (
			incoming as {
				nodes: Array<{
					name: string;
					location: { line: number; character: number };
					open: { input: { workspaceId: string; path: string } };
				}>;
			}
		).nodes;
		const caller = incomingNodes.find((node) => node.name === "middle");
		if (!caller) throw new Error("Missing live caller node");
		expect(caller.location).toMatchObject({ line: 5, character: 17 });
		const opened = reference(await command(registered.commands, "lector.file.open").execute(caller.open.input));
		expect(await read(registered.provider(), opened)).toMatchObject({
			kind: "text",
			path: CALL_GRAPH_PATH,
			content: expect.stringContaining("export function middle"),
		});
		expect(incoming).toMatchObject({
			kind: "call-graph",
			direction: "incoming",
			status: "ready",
			provenance: { source: "live-language-server", intelligence: { freshness: "live-process" } },
			nodes: expect.arrayContaining([
				expect.objectContaining({ name: "leaf", location: expect.objectContaining({ path: CALL_GRAPH_PATH }) }),
				expect.objectContaining({ name: "middle", open: expect.objectContaining({ commandId: "lector.file.open" }) }),
			]),
			edges: [expect.objectContaining({ kind: "calls" })],
			truncated: false,
		});

		const outgoing = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.outgoing").execute({
					workspaceId,
					path: CALL_GRAPH_PATH,
					line: 5,
					character: 17,
					maxNodes: 20,
					maxEdges: 20,
					maxBytes: 50_000,
					deadlineMs: 10_000,
				}),
			),
		);
		expect(outgoing).toMatchObject({
			direction: "outgoing",
			nodes: expect.arrayContaining([expect.objectContaining({ name: "leaf" }), expect.objectContaining({ name: "middle" })]),
		});

		const populated = await daemon.client.call("workspace.populateSymbolGraph", { workspaceId, maxFiles: 20, maxSymbolsPerFile: 100 });
		expect(populated.edgesAdded).toBeGreaterThan(0);
		const reachable = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.reachable").execute({
					workspaceId,
					path: CALL_GRAPH_PATH,
					line: 9,
					character: 17,
					maxDepth: 2,
					maxNodes: 20,
					maxEdges: 20,
					maxBytes: 50_000,
					deadlineMs: 10_000,
					cacheBounds: { maxFiles: 20, maxSymbolsPerFile: 100 },
				}),
			),
		);
		const projectedNodes = (reachable as { nodes: Array<{ id: string }> }).nodes;
		expect(new Set(projectedNodes.map((node) => node.id)).size).toBe(projectedNodes.length);
		expect(reachable).toMatchObject({
			kind: "call-graph",
			direction: "reachable",
			status: "ready",
			provenance: { source: "persisted-symbol-graph" },
			nodes: expect.arrayContaining([
				expect.objectContaining({ name: "middle", location: expect.objectContaining({ path: CALL_GRAPH_PATH }) }),
				expect.objectContaining({ name: "leaf", location: expect.objectContaining({ path: CALL_GRAPH_PATH }) }),
			]),
			edges: expect.arrayContaining([expect.objectContaining({ kind: "calls" })]),
		});
	});

	it("keeps cycles stable and makes graph bounds, partial caches, stale caches, deadlines, and resource caps explicit", async () => {
		const root = hierarchy("a", "/tmp/project/a.ts", 1, 17);
		const b = { id: "/tmp/project/b.ts:1:17", name: "b", kind: "function", location: { path: "/tmp/project/b.ts", line: 1, character: 17 } };
		const c = { id: "/tmp/project/c.ts:1:17", name: "c", kind: "function", location: { path: "/tmp/project/c.ts", line: 1, character: 17 } };
		let cacheStatus: "partial" | "not-cached" = "partial";
		let holdPrepare = false;
		const operations: LectorOperations = {
			call: async (operation, input) => {
				if (operation === "workspace.registerPath") return { workspaceId: "ws" };
				if (operation === "workspace.prepareCallHierarchy") {
					if (holdPrepare) return await new Promise(() => undefined);
					return { items: [root], provenance: provenance() };
				}
				if (operation === "workspace.outgoingCalls")
					return {
						calls: [
							{ to: hierarchy("b", "/tmp/project/b.ts", 1, 17), fromRanges: [] },
							{ to: hierarchy("c", "/tmp/project/c.ts", 1, 17), fromRanges: [] },
						],
						provenance: provenance(),
					};
				if (operation === "workspace.cacheStatus")
					return cacheStatus === "partial" ? { status: "partial", generation: {} } : { status: "not-cached", reason: "source-changed" };
				if (operation === "workspace.symbolEdgesFrom") {
					const path = typeof input === "object" && input !== null && "path" in input ? input.path : undefined;
					if (path === "/tmp/project/a.ts") return { symbols: [b, c] };
					if (path === "/tmp/project/b.ts") return { symbols: [{ id: "/tmp/project/a.ts:1:17", name: "a", kind: "function", location: root.location }] };
					return { symbols: [] };
				}
				throw new Error(`unexpected ${operation}`);
			},
		};
		const registered = host();
		await createLectorAlignmentContribution({ operations }).activate(registered.api);
		await command(registered.commands, "lector.workspace.open").execute({ path: "/tmp/project" });

		const partialRef = reference(
			await command(registered.commands, "lector.call-graph.reachable").execute({
				workspaceId: "ws",
				path: "a.ts",
				line: 1,
				character: 17,
				maxDepth: 3,
				maxNodes: 2,
				maxEdges: 10,
				maxBytes: 50_000,
				deadlineMs: 1_000,
				cacheBounds: { maxFiles: 10, maxSymbolsPerFile: 20 },
			}),
		);
		const partial = await read(registered.provider(), partialRef);
		const partialGraph = partial as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> };
		expect(new Set(partialGraph.nodes.map((node) => node.id)).size).toBe(partialGraph.nodes.length);
		expect(partialGraph.edges).toHaveLength(2);
		expect(partialGraph.edges.some((edge) => partialGraph.edges.some((other) => edge.from === other.to && edge.to === other.from))).toBe(true);
		expect(partial).toMatchObject({ status: "partial", truncated: true, truncatedBy: ["nodes"], provenance: { source: "persisted-symbol-graph" } });
		expect(await registered.provider()?.read(partialRef, { maxBytes: 10, maxEntries: 100 })).toMatchObject({ ok: false, code: "resource-bound-exceeded" });

		const depthBounded = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.reachable").execute({
					workspaceId: "ws",
					path: "a.ts",
					line: 1,
					character: 17,
					maxDepth: 1,
					maxNodes: 10,
					maxEdges: 10,
					maxBytes: 50_000,
					deadlineMs: 1_000,
					cacheBounds: { maxFiles: 10, maxSymbolsPerFile: 20 },
				}),
			),
		);
		expect(depthBounded).toMatchObject({ status: "partial", truncated: true, truncatedBy: ["depth"] });

		const edgeBounded = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.outgoing").execute({
					workspaceId: "ws",
					path: "a.ts",
					line: 1,
					character: 17,
					maxNodes: 10,
					maxEdges: 1,
					maxBytes: 50_000,
					deadlineMs: 1_000,
				}),
			),
		);
		expect(edgeBounded).toMatchObject({ truncated: true, truncatedBy: ["edges"], edges: [expect.objectContaining({ kind: "calls" })] });
		expect(
			await command(registered.commands, "lector.call-graph.outgoing").execute({
				workspaceId: "ws",
				path: "a.ts",
				line: 1,
				character: 17,
				maxNodes: 10,
				maxEdges: 10,
				maxBytes: 100,
				deadlineMs: 1_000,
			}),
		).toMatchObject({ ok: false, code: "resource-bound-exceeded" });

		cacheStatus = "not-cached";
		const stale = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.call-graph.reachable").execute({
					workspaceId: "ws",
					path: "a.ts",
					line: 1,
					character: 17,
					maxDepth: 2,
					maxNodes: 10,
					maxEdges: 10,
					maxBytes: 50_000,
					deadlineMs: 1_000,
					cacheBounds: { maxFiles: 10, maxSymbolsPerFile: 20 },
				}),
			),
		);
		expect(stale).toMatchObject({ status: "stale", nodes: [], edges: [], staleReason: "source-changed" });

		holdPrepare = true;
		expect(
			await command(registered.commands, "lector.call-graph.outgoing").execute({
				workspaceId: "ws",
				path: "a.ts",
				line: 1,
				character: 17,
				maxNodes: 10,
				maxEdges: 10,
				maxBytes: 50_000,
				deadlineMs: 5,
			}),
		).toMatchObject({ ok: false, code: "deadline-exceeded" });

		const controller = new AbortController();
		const canceled = command(registered.commands, "lector.call-graph.outgoing").execute({
			workspaceId: "ws",
			path: "a.ts",
			line: 1,
			character: 17,
			maxNodes: 10,
			maxEdges: 10,
			maxBytes: 50_000,
			deadlineMs: 1_000,
			signal: controller.signal,
		});
		controller.abort();
		expect(await canceled).toMatchObject({ ok: false, code: "canceled" });
	});
});
