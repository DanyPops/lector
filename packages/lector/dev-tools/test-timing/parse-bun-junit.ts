import type { TestOutcome, TestTimingEntry } from "./parse-bun-test-output.ts";

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

function decodeXml(value: string): string {
	let decoded = value;
	for (let pass = 0; pass < 2; pass++) {
		const next = decoded.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (encoded, entity: string) => {
			if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
			if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
			return XML_ENTITIES[entity] ?? encoded;
		});
		if (next === decoded) break;
		decoded = next;
	}
	return decoded;
}

function attributesOf(raw: string): ReadonlyMap<string, string> {
	const attributes = new Map<string, string>();
	for (const match of raw.matchAll(ATTRIBUTE)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) attributes.set(name, decodeXml(value));
	}
	return attributes;
}

/** Parses Bun's JUnit output, whose testcase attributes preserve authoritative file ownership and duration independently of console stream ordering. */
export function parseBunJunitReport(xml: string): readonly TestTimingEntry[] {
	const entries: TestTimingEntry[] = [];
	for (const match of xml.matchAll(TESTCASE)) {
		const attributes = attributesOf(match[1] ?? "");
		const file = attributes.get("file");
		const name = attributes.get("name");
		if (!file || !name) throw new TypeError("JUnit testcase requires non-empty file and name attributes");
		const body = match[2] ?? "";
		const outcome: TestOutcome = /<failure\b/.test(body) || /<error\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass";
		const rawSeconds = attributes.get("time");
		const seconds = rawSeconds === undefined ? Number.NaN : Number(rawSeconds);
		if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError(`invalid testcase time for ${file} :: ${name}`);
		const classname = attributes.get("classname");
		entries.push({
			file,
			name: classname && !name.startsWith(`${classname} >`) ? `${classname} > ${name}` : name,
			outcome,
			durationMs: outcome === "skip" ? undefined : seconds * 1_000,
		});
	}
	return entries;
}
