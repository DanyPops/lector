import {
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createLectorEditOperations } from "./edit-operations.ts";
import { createLectorReadOperations } from "./read-operations.ts";
import { createLectorWriteOperations } from "./write-operations.ts";

/**
 * pi-lector -- the thin Pi host adapter for Lector (lector-generic-capability-design-kkje,
 * walking-skeleton step 4). Overrides the built-in read/write/edit tools by
 * name with Lector-backed Operations, so built-in rendering (syntax
 * highlighting, diffs, truncation banners) is kept for free while every
 * actual file operation routes through a running Lector daemon.
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
	});
}
