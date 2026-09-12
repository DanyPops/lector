import { connectLectorClient } from "../../../client.ts";
import { fail, flagValue, hasFlag, requiredIntFlag } from "../../flags.ts";
import { USAGE } from "../../usage.ts";

function seedArray(flags: string[], flag: string): unknown[] | undefined {
	const raw = flagValue(flags, flag);
	if (raw === undefined) return undefined;
	if (Buffer.byteLength(raw) > 1_048_576) fail(`${flag} exceeds the input limit`);
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || value.length > 100) fail(`${flag} requires an array of at most 100 entries`);
	const entries: unknown[] = value;
	return entries;
}

/** Localizes a task through the authenticated daemon, preserving structured completeness in JSON output. */
export async function runWorkspaceLocalize(workspaceId: string | undefined, query: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !query) fail(USAGE);
	const seedSymbols = seedArray(flags, "--seed-symbols-json")?.map((value) => {
		if (typeof value !== "string" || value.length === 0) fail("seed symbols must be non-empty strings");
		return value;
	});
	const seedLocations = seedArray(flags, "--seed-locations-json")?.map((value) => {
		if (
			typeof value !== "object" ||
			value === null ||
			!("path" in value) ||
			typeof value.path !== "string" ||
			!("line" in value) ||
			typeof value.line !== "number" ||
			!Number.isSafeInteger(value.line) ||
			value.line < 1
		)
			fail("seed locations require a path and positive line");
		const character = "character" in value ? value.character : undefined;
		if (character !== undefined && (typeof character !== "number" || !Number.isSafeInteger(character) || character < 1))
			fail("seed characters must be positive integers");
		return { path: value.path, line: value.line, ...(character === undefined ? {} : { character }) };
	});
	const client = await connectLectorClient();
	const result = await client.call("workspace.localizeContext", {
		workspaceId,
		query,
		maxSymbols: requiredIntFlag(flags, "--max-symbols"),
		maxBytes: requiredIntFlag(flags, "--max-bytes"),
		maxDepth: requiredIntFlag(flags, "--max-depth"),
		deadlineMs: requiredIntFlag(flags, "--deadline-ms"),
		...(seedSymbols ? { seedSymbols } : {}),
		...(seedLocations ? { seedLocations } : {}),
	});
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(result));
		return;
	}
	for (const candidate of result.candidates) console.log(`${candidate.kind} ${candidate.name} -- ${candidate.path}:${candidate.line}:${candidate.character}`);
	console.log(
		`Completeness: lexical=${result.completeness.lexical}, graph=${result.completeness.graph}, truncated=${result.truncated}, deadline=${result.completeness.deadlineReached}`,
	);
}
