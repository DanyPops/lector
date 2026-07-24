import type { CodeIntelligencePort } from "../ports/code-intelligence-port.ts";
import type { Diagnostic } from "./diagnostic.ts";

/** Every diagnostic currently known for one file (errors, warnings, and below), as of the server's last analysis. */
export async function diagnostics(index: CodeIntelligencePort, path: string): Promise<Diagnostic[]> {
	return index.diagnostics(path);
}
