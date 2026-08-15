import type { ResolutionContext } from "../resolution-context.ts";
import { evidence, isRecord, type ParsedEvidence, stringField, UnsupportedLockfile } from "./shared.ts";

function parseJson(text: string, context: ResolutionContext): unknown {
	try {
		return JSON.parse(text);
	} catch {
		context.reportDiagnostics(1);
		throw new Error("invalid JSON lockfile");
	}
}

export function parseNpmLock(text: string, lockfile: string, packageName: string, context: ResolutionContext): ParsedEvidence[] {
	const parsed = parseJson(text, context);
	if (!isRecord(parsed)) throw new Error("lockfile root is not an object");
	const lockfileVersion = parsed.lockfileVersion;
	if (lockfileVersion !== 2 && lockfileVersion !== 3) throw new UnsupportedLockfile();
	if (!isRecord(parsed.packages)) throw new Error("packages is missing");
	const results: ParsedEvidence[] = [];
	for (const [locator, rawEntry] of Object.entries(parsed.packages)) {
		context.touchEntry();
		if (!isRecord(rawEntry)) continue;
		const workspace = !locator.includes("node_modules");
		if (workspace) context.touchWorkspace(locator);
		const declaredName = stringField(rawEntry, "name");
		const isRequestedWorkspace = workspace && declaredName === packageName;
		const isInstalledEntry = locator === `node_modules/${packageName}` || locator.endsWith(`/node_modules/${packageName}`);
		if (!isRequestedWorkspace && !isInstalledEntry) continue;
		let version = stringField(rawEntry, "version");
		if (version === null && rawEntry.link === true) {
			const target = stringField(rawEntry, "resolved");
			const targetEntry = target ? parsed.packages[target] : undefined;
			if (isRecord(targetEntry)) version = stringField(targetEntry, "version");
		}
		if (version === null) continue;
		results.push({
			version,
			evidence: evidence("npm", lockfile, locator, stringField(rawEntry, "integrity"), workspace || rawEntry.link === true),
		});
	}
	return results;
}
