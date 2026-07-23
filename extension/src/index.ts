import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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
 * grep/find/ls are not overridden -- no Lector operation backs them yet.
 * No daemon auto-spawn: a Lector-backed tool call fails with a clear
 * "start it with `lector serve`" error if none is reachable, matching
 * Papyrus's own posture of explicit service management.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const { cwd } = ctx;
		pi.registerTool(createReadToolDefinition(cwd, { operations: createLectorReadOperations(cwd) }));
		pi.registerTool(createWriteToolDefinition(cwd, { operations: createLectorWriteOperations(cwd) }));
		pi.registerTool(createEditToolDefinition(cwd, { operations: createLectorEditOperations(cwd) }));

		const findSymbolsOperations = createLectorFindSymbolsOperations(cwd);
		pi.registerTool({
			name: "find_symbols",
			label: "Find Symbols",
			description:
				"Search the current workspace for functions, classes, interfaces, types, enums, and methods by name (case-insensitive substring match). Returns each match's kind and file location.",
			promptSnippet: "Search the workspace for a symbol (function, class, etc.) by name",
			promptGuidelines: [
				"Use find_symbols to locate where a function, class, interface, type, enum, or method is declared by name, instead of grepping for it.",
			],
			parameters: Type.Object({ query: Type.String({ description: "Name or substring to search for, case-insensitive" }) }),
			async execute(_toolCallId, params) {
				const symbols = await findSymbolsOperations.findSymbols(params.query);
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
