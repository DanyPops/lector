import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { ContributionCommand, ContributionResourceProvider, ContributionResourceReference } from "@alignment/surface-protocol";
import { createLectorAlignmentContribution, type LectorOperations, lectorOperationsFromClient } from "../src/index.js";
import { startIsolatedDaemon } from "./support/isolated-daemon.js";

const FIXTURE_ROOT = resolve(import.meta.dir, "../../lector/test/fixtures/typescript-reference");
const CHECKOUT_PATH = "packages/app/src/checkout.ts";
const DIAGNOSTIC_PATH = "packages/app/src/type-error.ts";

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

describe("Lector Alignment semantic navigation", () => {
	let stop: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await stop?.();
		stop = undefined;
	});

	it("projects search, hover, definition, references, and diagnostics from a real TypeScript language server", async () => {
		const daemon = await startIsolatedDaemon();
		stop = daemon.stop;
		const registered = host();
		const contribution = createLectorAlignmentContribution({ operations: lectorOperationsFromClient(daemon.client) });
		await contribution.activate(registered.api);
		const workspace = reference(await command(registered.commands, "lector.workspace.open").execute({ path: FIXTURE_ROOT }));
		const workspaceId = decodeURIComponent(new URL(workspace.uri).pathname.slice(1));

		const text = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.search.text").execute({ workspaceId, query: "runCheckout", maxMatches: 20, maxBytes: 10_000 })),
		);
		expect(text).toMatchObject({
			kind: "search-results",
			status: "ready",
			truncated: false,
			items: expect.arrayContaining([expect.objectContaining({ path: "packages/app/src/main.ts" })]),
		});

		const files = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.search.files").execute({
					workspaceId,
					patterns: ["packages/app/src/*.ts"],
					maxResults: 20,
					maxBytes: 10_000,
				}),
			),
		);
		expect(files).toMatchObject({ kind: "file-results", status: "ready", items: expect.arrayContaining([CHECKOUT_PATH, DIAGNOSTIC_PATH]) });

		const definition = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.symbol.definition").execute({ workspaceId, path: CHECKOUT_PATH, line: 4, character: 18 })),
		);
		expect(definition).toMatchObject({
			kind: "locations",
			status: "ready",
			positionEncoding: "utf-16",
			items: [expect.objectContaining({ path: CHECKOUT_PATH, line: 3 })],
			provenance: { fidelity: "semantic" },
		});

		const hover = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.symbol.hover").execute({ workspaceId, path: CHECKOUT_PATH, line: 3, character: 23 })),
		);
		expect(hover).toMatchObject({
			kind: "hover",
			status: "ready",
			positionEncoding: "utf-16",
			provenance: { fidelity: "semantic", authority: "language-server" },
		});
		expect(JSON.stringify(hover)).toContain("runCheckout");

		const references = await read(
			registered.provider(),
			reference(
				await command(registered.commands, "lector.symbol.references").execute({
					workspaceId,
					path: CHECKOUT_PATH,
					line: 3,
					character: 23,
					includeDeclaration: true,
				}),
			),
		);
		expect(references).toMatchObject({ kind: "locations", status: "ready", positionEncoding: "utf-16", provenance: { fidelity: "semantic" } });
		expect(JSON.stringify(references)).toContain(CHECKOUT_PATH);

		const diagnostics = await read(
			registered.provider(),
			reference(await command(registered.commands, "lector.diagnostics.show").execute({ workspaceId, path: DIAGNOSTIC_PATH })),
		);
		expect(diagnostics).toMatchObject({
			kind: "diagnostics",
			status: "ready",
			positionEncoding: "utf-16",
			items: [expect.objectContaining({ severity: "error", range: expect.objectContaining({ path: DIAGNOSTIC_PATH }) })],
			provenance: { fidelity: "semantic" },
		});
	});

	it("preserves degraded/stale provenance, caps result resources, and cancels without caching late work", async () => {
		let finish: ((value: unknown) => void) | undefined;
		const operations: LectorOperations = {
			call: async (operation, input) => {
				if (operation === "workspace.registerPath") return { workspaceId: "ws", created: true };
				if (operation === "workspace.goToDefinition")
					return {
						locations: [
							{ path: "a.ts", line: 1, character: 1 },
							{ path: "b.ts", line: 2, character: 2 },
						],
						provenance: {
							fidelity: "structural",
							backend: "tree-sitter",
							languageId: "typescript",
							authority: "parser",
							freshness: "filesystem-snapshot",
							limitations: ["cross-file aliases unavailable"],
						},
					};
				if (
					operation === "workspace.hover" &&
					typeof input === "object" &&
					input !== null &&
					"path" in input &&
					typeof input.path === "string" &&
					input.path.endsWith("stale.ts")
				)
					return {
						hover: { contents: "stale hover" },
						provenance: {
							fidelity: "semantic",
							backend: "typescript-language-server",
							languageId: "typescript",
							authority: "language-server",
							freshness: "content-hash",
							limitations: [],
						},
					};
				if (operation === "workspace.hover") return await new Promise((resolve) => (finish = resolve));
				throw new Error("UnsupportedLanguage: unsupported fixture");
			},
		};
		const registered = host();
		await createLectorAlignmentContribution({ operations }).activate(registered.api);
		await command(registered.commands, "lector.workspace.open").execute({ path: "/tmp/project" });
		const degraded = reference(
			await command(registered.commands, "lector.symbol.definition").execute({ workspaceId: "ws", path: "a.ts", line: 1, character: 1 }),
		);
		expect(await read(registered.provider(), degraded)).toMatchObject({
			status: "degraded",
			provenance: { freshness: "filesystem-snapshot", limitations: ["cross-file aliases unavailable"] },
		});
		expect(await registered.provider()?.read(degraded, { maxBytes: 100_000, maxEntries: 1 })).toMatchObject({ ok: false, code: "resource-bound-exceeded" });

		const stale = reference(await command(registered.commands, "lector.symbol.hover").execute({ workspaceId: "ws", path: "stale.ts", line: 1, character: 1 }));
		expect(await read(registered.provider(), stale)).toMatchObject({ status: "stale", provenance: { freshness: "content-hash" } });

		expect(await command(registered.commands, "lector.diagnostics.show").execute({ workspaceId: "ws", path: "x.unknown" })).toMatchObject({
			ok: false,
			code: "unsupported",
		});

		const controller = new AbortController();
		const pending = command(registered.commands, "lector.symbol.hover").execute({
			workspaceId: "ws",
			path: "a.ts",
			line: 1,
			character: 1,
			signal: controller.signal,
		});
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, code: "canceled" });
		finish?.({ hover: { contents: "late" }, provenance: { fidelity: "semantic" } });
	});
});
