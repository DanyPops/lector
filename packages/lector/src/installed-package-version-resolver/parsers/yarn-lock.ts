import { parseSyml } from "@yarnpkg/parsers";
import type { ResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, numericVersion, type ParsedEvidence, stringField, UnsupportedLockfile, versionFromLocator, workspaceLocator } from "./shared.ts";

export function parseYarnLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	let parsed: unknown;
	try {
		parsed = parseSyml(text);
	} catch {
		context.reportDiagnostics(1);
		throw new Error("invalid Yarn lockfile");
	}
	if (!isRecord(parsed)) throw new Error("lockfile root is not an object");
	const metadata = parsed.__metadata;
	if (metadata !== undefined) {
		if (!isRecord(metadata)) throw new Error("invalid Yarn metadata");
		const version = numericVersion(metadata.version);
		if (version === null || version < 4 || version > 8) throw new UnsupportedLockfile();
	}
	const results: ParsedEvidence[] = [];
	for (const [locator, rawEntry] of Object.entries(parsed)) {
		if (locator === "__metadata") continue;
		context.touchEntry();
		if (!isRecord(rawEntry)) continue;
		const selectors = locator.split(",").map((selector) => selector.trim());
		for (const selector of selectors) {
			const workspace = workspaceLocator(selector);
			if (workspace === null) continue;
			context.touchWorkspace(workspace.path);
			if (workspace.name !== packageName) continue;
			const candidate = context.workspaceVersion(workspace.path, packageName, lockfile, "yarn");
			if (candidate !== null) results.push(candidate);
		}
		if (!selectors.some((selector) => versionFromLocator(selector, packageName) !== null)) continue;
		const version = stringField(rawEntry, "version");
		if (version === null || selectors.some((selector) => workspaceLocator(selector)?.name === packageName)) continue;
		results.push({
			version,
			evidence: evidence("yarn", lockfile, locator, stringField(rawEntry, "integrity") ?? stringField(rawEntry, "checksum"), false),
		});
	}
	return results;
}
