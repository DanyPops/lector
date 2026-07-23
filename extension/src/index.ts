import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { createLectorEditOperations } from "./edit-operations.ts";
import { createLectorFindSymbolsOperations } from "./find-symbols-operations.ts";
import { createLectorReadOperations } from "./read-operations.ts";
import { createLectorWriteOperations } from "./write-operations.ts";

/**
 * pi-lector -- the thin Pi host adapter for Lector (lector-generic-capability-design-kkje,
 * walking-skeleton step 4-5). Overrides the built-in read/write/edit tools by
 * name with Lector-backed Operations, so built-in rendering (syntax
 * highlighting, diffs, truncation banners) is kept for free while every
 * actual file operation routes through a running Lector daemon. Adds
 * find_symbols, a new tool with no built-in pi-coding-agent equivalent, for
 * Lector's code-intelligence side (workspace.findSymbols).
 *
 * read/write/edit's Lector-backed Operations resolve their own workspace
 * per absolute path touched (see workspaceForPath) -- never from `cwd`
 * captured here. A prior version passed `cwd` straight into each Operations
 * factory and used it as the one-and-only workspace boundary for the whole
 * session, which hard-refused every legitimate absolute path outside it
 * (a real, shipped bug, discovered live: a session whose cwd was one repo
 * could not touch files in a completely different, unrelated repo at all).
 * `cwd` is still passed to createReadToolDefinition/etc. themselves -- that's
 * pi-coding-agent's own concern (relative-path display in the tool UI), not
 * Lector's workspace resolution.
 *
 * grep/find/ls are not overridden -- no Lector operation backs them yet.
 * No daemon auto-spawn: a Lector-backed tool call fails with a clear
 * "start it with `lector serve`" error if none is reachable, matching
 * Papyrus's own posture of explicit service management.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const { cwd } = ctx;
		pi.registerTool(createReadToolDefinition(cwd, { operations: createLectorReadOperations() }));
		pi.registerTool(createWriteToolDefinition(cwd, { operations: createLectorWriteOperations() }));
		pi.registerTool(createEditToolDefinition(cwd, { operations: createLectorEditOperations() }));

		const findSymbolsOperations = createLectorFindSymbolsOperations(cwd);
		pi.registerTool({
			name: "find_symbols",
			label: "Find Symbols",
			description:
				"Search a workspace for functions, classes, interfaces, types, enums, and methods by name " +
				"(case-insensitive substring match). Returns each match's kind and file location. Defaults to " +
				"the current project; pass `directory` to search a different one without needing to be in it.",
			promptSnippet: "Search a workspace for a symbol (function, class, etc.) by name",
			promptGuidelines: [
				"Use find_symbols to locate where a function, class, interface, type, enum, or method is declared by name, instead of grepping for it.",
				"Pass find_symbols' directory argument to search a different project than the current one -- it is not limited to the session's own working directory.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Name or substring to search for, case-insensitive" }),
				directory: Type.Optional(
					Type.String({ description: "Directory of the project to search, absolute or relative to the current working directory; defaults to the current project" }),
				),
			}),
			async execute(_toolCallId, params) {
				const directory = params.directory === undefined ? undefined : resolve(cwd, params.directory);
				const symbols = await findSymbolsOperations.findSymbols(params.query, directory);
				const text =
					symbols.length === 0
						? `No symbols found matching "${params.query}".`
						: symbols
								.map((symbol) => `${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`)
								.join("\n");
				return { content: [{ type: "text", text }], details: { symbols } };
			},
		});
	});
}
