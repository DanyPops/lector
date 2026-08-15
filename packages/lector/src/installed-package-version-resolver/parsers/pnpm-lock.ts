import { parseDocument } from "yaml";
import type { ResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, numericVersion, type ParsedEvidence, stringField, UnsupportedLockfile, versionFromLocator } from "./shared.ts";

export function parsePnpmLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	const document = parseDocument(text);
	context.reportDiagnostics(document.errors.length + document.warnings.length);
	if (document.errors.length > 0) throw new Error("invalid pnpm YAML");
	const parsed: unknown = document.toJS({ maxAliasCount: Math.min(context.bounds.maxManifestEntries, 1_000) });
	if (!isRecord(parsed)) throw new Error("lockfile root is not an object");
	const lockfileVersion = numericVersion(parsed.lockfileVersion);
	if (lockfileVersion === null || lockfileVersion < 5.3 || lockfileVersion >= 10) throw new UnsupportedLockfile();
	if (!isRecord(parsed.packages) && !isRecord(parsed.importers)) throw new Error("packages and importers are missing");
	const results: ParsedEvidence[] = [];
	if (isRecord(parsed.importers)) {
		for (const workspacePath of Object.keys(parsed.importers)) {
			context.touchEntry();
			const workspace = context.workspaceVersion(workspacePath, packageName, lockfile, "pnpm");
			if (workspace !== null) results.push(workspace);
		}
	}
	for (const [locator, rawEntry] of Object.entries(isRecord(parsed.packages) ? parsed.packages : {})) {
		context.touchEntry();
		const version = versionFromLocator(locator, packageName);
		if (version === null) continue;
		const integrity = isRecord(rawEntry) && isRecord(rawEntry.resolution) ? stringField(rawEntry.resolution, "integrity") : null;
		results.push({ version, evidence: evidence("pnpm", lockfile, locator, integrity, false) });
	}
	return results;
}
