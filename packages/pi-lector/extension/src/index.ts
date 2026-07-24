import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { WorkspaceSymbol } from "@danypops/lector";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { Type } from "typebox";
import { createLectorEditOperations } from "./edit-operations.ts";
import { createLectorFindSymbolsOperations } from "./find-symbols-operations.ts";
import { formatFindSymbolsCall, formatFindSymbolsResult } from "./find-symbols-rendering.ts";
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

		const findSymbolsOperations = createLectorFindSymbolsOperations();
		pi.registerTool({
			name: "find_symbols",
			label: "Find Symbols",
			description:
				"Search a workspace for functions, classes, interfaces, types, enums, and methods by name " +
				"(case-insensitive substring match). Returns each match's kind and file location. `directory` " +
				"selects which project to search -- pass the current working directory to search it, or any " +
				"other project's directory to get code intelligence there without needing to be in it.",
			promptSnippet: "Search a workspace for a symbol (function, class, etc.) by name",
			promptGuidelines: [
				"Use find_symbols to locate where a function, class, interface, type, enum, or method is declared by name, instead of grepping for it.",
				"find_symbols' directory argument selects which project to search; it is never inferred, so pass the current working directory explicitly to search the current project, or another project's directory to search that one instead.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Name or substring to search for, case-insensitive" }),
				directory: Type.String({ description: "Directory of the project to search, absolute or relative to the current working directory" }),
			}),
			async execute(_toolCallId, params) {
				const directory = resolve(cwd, params.directory);
				const symbols = await findSymbolsOperations.findSymbols(params.query, directory);
				const text =
					symbols.length === 0
						? `No symbols found matching "${params.query}".`
						: symbols
								.map((symbol) => `${symbol.kind} ${symbol.name} -- ${symbol.location.path}:${symbol.location.line}:${symbol.location.character}`)
								.join("\n");
				return { content: [{ type: "text", text }], details: { symbols } };
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsCall(args as { query?: unknown; directory?: unknown }, theme));
				return text;
			},
			renderResult(result, { expanded, isPartial }, theme, context) {
				if (isPartial) {
					return new Text(theme.fg("warning", "Searching..."), 0, 0);
				}
				if (context.isError) {
					const errorText = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					return new Text(theme.fg("error", errorText || "find_symbols failed"), 0, 0);
				}
				const details = result.details as { symbols?: readonly WorkspaceSymbol[] } | undefined;
				const query = typeof context.args?.query === "string" ? context.args.query : "";
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(formatFindSymbolsResult(details?.symbols, query, expanded, theme));
				return text;
			},
		});
	});
}
