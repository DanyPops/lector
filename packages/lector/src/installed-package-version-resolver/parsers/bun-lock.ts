import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import type { ResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, type ParsedEvidence, stringField, UnsupportedLockfile, versionFromLocator } from "./shared.ts";

export function parseBunLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
	context.reportDiagnostics(errors.length);
	if (errors.length > 0 || !isRecord(parsed)) throw new Error("invalid Bun lockfile");
	if (parsed.lockfileVersion !== 1) throw new UnsupportedLockfile();
	if (!isRecord(parsed.packages)) throw new Error("packages is missing");
	const results: ParsedEvidence[] = [];
	if (isRecord(parsed.workspaces)) {
		for (const [workspacePath, rawWorkspace] of Object.entries(parsed.workspaces)) {
			context.touchEntry();
			context.touchWorkspace(workspacePath);
			if (isRecord(rawWorkspace) && stringField(rawWorkspace, "name") === packageName) {
				const version = stringField(rawWorkspace, "version");
				if (version !== null) {
					results.push({ version, evidence: evidence("bun", lockfile, workspacePath, null, true) });
					continue;
				}
			}
			const workspace = context.workspaceVersion(workspacePath, packageName, lockfile, "bun");
			if (workspace !== null) results.push(workspace);
		}
	}
	for (const [locator, rawEntry] of Object.entries(parsed.packages)) {
		context.touchEntry();
		if (!Array.isArray(rawEntry) || typeof rawEntry[0] !== "string") continue;
		const version = versionFromLocator(rawEntry[0], packageName);
		if (version === null) continue;
		const integrity = typeof rawEntry[3] === "string" && rawEntry[3].length > 0 ? rawEntry[3] : null;
		results.push({ version, evidence: evidence("bun", lockfile, locator, integrity, false) });
	}
	return results;
}
